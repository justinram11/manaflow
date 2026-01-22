import { query } from "@anthropic-ai/claude-agent-sdk";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { z } from "zod";

import { logToScreenshotCollector } from "./logger";
import { formatClaudeMessage } from "./claudeMessageFormatter";

export const SCREENSHOT_STORAGE_ROOT = "/root/screenshots";
export const EVENTS_LOG_FILENAME = "events.log";

// Chrome DevTools Protocol port (same as chrome-devtools-mcp)
const CDP_PORT = 39382;

/**
 * Get bounding rect for an element via Chrome DevTools Protocol.
 * The uid from chrome-devtools-mcp is assumed to be "contextId_nodeId" or similar format.
 * We extract the nodeId and call DOM.getBoxModel.
 */
async function getBoundingRectFromCDP(
  uid: string
): Promise<{ x: number; y: number; width: number; height: number } | null> {
  try {
    // Get CDP WebSocket URL
    const targetsResponse = await fetch(`http://0.0.0.0:${CDP_PORT}/json`);
    const targets = (await targetsResponse.json()) as Array<{
      type?: string;
      webSocketDebuggerUrl?: string;
    }>;
    const pageTarget = targets.find(
      (t) => t.type === "page" && t.webSocketDebuggerUrl
    );

    if (!pageTarget?.webSocketDebuggerUrl) {
      return null;
    }

    // Parse uid to extract nodeId (assume format "contextId_nodeId" or just nodeId)
    const parts = uid.split("_");
    const nodeIdStr = parts[parts.length - 1] ?? "";
    const nodeId = parseInt(nodeIdStr, 10);

    if (isNaN(nodeId)) {
      return null;
    }

    const wsUrl = pageTarget.webSocketDebuggerUrl;
    if (!wsUrl) {
      return null;
    }

    // Connect to CDP via WebSocket and get box model
    return new Promise((resolve) => {
      const ws = new WebSocket(wsUrl);
      let resolved = false;

      const cleanup = () => {
        if (!resolved) {
          resolved = true;
          resolve(null);
        }
        try {
          ws.close();
        } catch {
          // ignore
        }
      };

      // Timeout after 3 seconds
      const timeout = setTimeout(cleanup, 3000);

      ws.addEventListener("open", () => {
        // Call DOM.getBoxModel to get element bounds
        ws.send(
          JSON.stringify({
            id: 1,
            method: "DOM.getBoxModel",
            params: { nodeId },
          })
        );
      });

      ws.addEventListener("message", (event) => {
        try {
          const response = JSON.parse(String(event.data)) as {
            id?: number;
            result?: {
              model?: {
                content?: number[];
              };
            };
          };

          if (response.id === 1) {
            clearTimeout(timeout);
            resolved = true;
            ws.close();

            const c = response.result?.model?.content;
            if (c && c.length >= 6) {
              // content is quad: [x1,y1, x2,y2, x3,y3, x4,y4]
              resolve({
                x: c[0] ?? 0,
                y: c[1] ?? 0,
                width: (c[2] ?? 0) - (c[0] ?? 0),
                height: (c[5] ?? 0) - (c[1] ?? 0),
              });
            } else {
              resolve(null);
            }
          }
        } catch {
          cleanup();
        }
      });

      ws.addEventListener("error", cleanup);
    });
  } catch {
    return null;
  }
}

// Placeholder API key that signals to the proxy to use platform credits (Bedrock)
const CMUX_ANTHROPIC_PROXY_PLACEHOLDER_API_KEY = "sk_placeholder_cmux_anthropic_api_key";

// Directories for Claude Code configuration (matches main dashboard setup)
const CLAUDE_LIFECYCLE_DIR = "/root/lifecycle/claude";
const CLAUDE_SECRETS_DIR = `${CLAUDE_LIFECYCLE_DIR}/secrets`;
const CLAUDE_API_KEY_HELPER_PATH = `${CLAUDE_SECRETS_DIR}/anthropic_key_helper.sh`;
const CLAUDE_SETTINGS_PATH = "/root/.claude/settings.json";
const CLAUDE_CONFIG_DIR = path.dirname(CLAUDE_SETTINGS_PATH);

// Environment variables that should be unset to ensure Claude Code uses proxy-only auth
const CLAUDE_KEY_ENV_VARS_TO_UNSET = [
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_API_KEY",
];

/**
 * Sets up Claude Code configuration using the same approach as the main dashboard.
 * This writes settings.json with apiKeyHelper instead of using ANTHROPIC_API_KEY env var.
 */
async function setupClaudeCodeConfig(options: {
  anthropicBaseUrl: string;
  customHeaders: string;
  apiKey: string;
}): Promise<void> {
  const { anthropicBaseUrl, customHeaders, apiKey } = options;

  // Ensure directories exist
  await fs.mkdir(CLAUDE_SECRETS_DIR, { recursive: true });
  await fs.mkdir(path.dirname(CLAUDE_SETTINGS_PATH), { recursive: true });

  // Create the apiKeyHelper script (like main dashboard does)
  const helperScript = `#!/bin/sh
echo ${apiKey}`;
  await fs.writeFile(CLAUDE_API_KEY_HELPER_PATH, helperScript, { mode: 0o700 });

  // Create settings.json with apiKeyHelper and env block (like main dashboard does)
  const settingsConfig = {
    apiKeyHelper: CLAUDE_API_KEY_HELPER_PATH,
    env: {
      CLAUDE_CODE_ENABLE_TELEMETRY: 0,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: 1,
      ANTHROPIC_BASE_URL: anthropicBaseUrl,
      ANTHROPIC_CUSTOM_HEADERS: customHeaders,
    },
  };

  await fs.writeFile(
    CLAUDE_SETTINGS_PATH,
    JSON.stringify(settingsConfig, null, 2),
    { mode: 0o644 }
  );

  await logToScreenshotCollector(
    `[setupClaudeCodeConfig] Created settings.json at ${CLAUDE_SETTINGS_PATH}`
  );
  await logToScreenshotCollector(
    `[setupClaudeCodeConfig] Created apiKeyHelper at ${CLAUDE_API_KEY_HELPER_PATH}`
  );
  await logToScreenshotCollector(
    `[setupClaudeCodeConfig] ANTHROPIC_BASE_URL: ${anthropicBaseUrl}`
  );
}

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const VIDEO_EXTENSIONS = new Set([".mp4", ".webm", ".mkv", ".gif"]);

function isScreenshotFile(fileName: string): boolean {
  return IMAGE_EXTENSIONS.has(path.extname(fileName).toLowerCase());
}

function isVideoFile(fileName: string): boolean {
  return VIDEO_EXTENSIONS.has(path.extname(fileName).toLowerCase());
}

async function collectMediaFiles(
  directory: string
): Promise<{ screenshots: string[]; videos: string[]; hasNestedDirectories: boolean }> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const screenshots: string[] = [];
  const videos: string[] = [];
  let hasNestedDirectories = false;

  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      hasNestedDirectories = true;
      const nested = await collectMediaFiles(fullPath);
      screenshots.push(...nested.screenshots);
      videos.push(...nested.videos);
    } else if (entry.isFile()) {
      if (isScreenshotFile(entry.name)) {
        screenshots.push(fullPath);
      } else if (isVideoFile(entry.name)) {
        videos.push(fullPath);
      }
    }
  }

  return { screenshots, videos, hasNestedDirectories };
}

export function normalizeScreenshotOutputDir(outputDir: string): string {
  if (path.isAbsolute(outputDir)) {
    return path.normalize(outputDir);
  }
  return path.resolve(SCREENSHOT_STORAGE_ROOT, outputDir);
}

export type ClaudeCodeAuthConfig =
  | { auth: { taskRunJwt: string } }
  | { auth: { anthropicApiKey: string } };

type BranchBaseOptions = {
  workspaceDir: string;
  changedFiles: string[];
  prTitle: string;
  prDescription: string;
  outputDir: string;
  pathToClaudeCodeExecutable?: string;
  /** Combined setup script (maintenance + dev), if provided */
  setupScript?: string;
  /** Command to install dependencies (e.g., "bun install", "npm install") */
  installCommand?: string;
  /** Command to start the dev server (e.g., "bun run dev", "npm run dev") */
  devCommand?: string;
  convexSiteUrl?: string;
};

type BranchCaptureOptions =
  | (BranchBaseOptions & { branch: string; auth: { taskRunJwt: string } })
  | (BranchBaseOptions & { branch: string; auth: { anthropicApiKey: string } });

type CaptureScreenshotsBaseOptions = BranchBaseOptions & {
  baseBranch: string;
  headBranch: string;
};

export type CaptureScreenshotsOptions =
  | (CaptureScreenshotsBaseOptions & { auth: { taskRunJwt: string } })
  | (CaptureScreenshotsBaseOptions & { auth: { anthropicApiKey: string } });

export interface ScreenshotResult {
  status: "completed" | "failed" | "skipped";
  screenshots?: { path: string; description?: string }[];
  videos?: { path: string; description?: string }[];
  hasUiChanges?: boolean;
  error?: string;
  reason?: string;
}

/**
 * Use Claude Agent SDK with Playwright MCP to capture screenshots
 * Assumes the workspace is already set up with the correct branch checked out
 */
function isTaskRunJwtAuth(
  auth: ClaudeCodeAuthConfig["auth"]
): auth is { taskRunJwt: string } {
  return "taskRunJwt" in auth;
}

function log(
  level: "INFO" | "WARN" | "ERROR",
  message: string,
  data?: Record<string, unknown>
): void {
  const logData = data ? ` ${JSON.stringify(data)}` : "";
  console.log(`[${level}] ${message}${logData}`);
}

function formatOptionalValue(value: string | null | undefined): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : "<unset>";
}

function formatSecretValue(value: string | null | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) return "<unset>";
  return `present(length=${trimmed.length})`;
}

export async function captureScreenshotsForBranch(
  options: BranchCaptureOptions
): Promise<{
  screenshots: { path: string; description?: string }[];
  videos: { path: string; description?: string }[];
  hasUiChanges?: boolean;
}> {
  const {
    workspaceDir,
    changedFiles,
    prTitle,
    prDescription,
    branch,
    outputDir: requestedOutputDir,
    auth,
    setupScript,
    installCommand,
    devCommand,
    convexSiteUrl,
  } = options;
  const outputDir = normalizeScreenshotOutputDir(requestedOutputDir);
  const useTaskRunJwt = isTaskRunJwtAuth(auth);

  if (!useTaskRunJwt) {
    await logToScreenshotCollector(
      "[ERROR] Direct Anthropic API key auth is disabled for screenshot collection. Provide taskRunJwt."
    );
    throw new Error(
      "Direct Anthropic API key auth is disabled for screenshot collection."
    );
  }

  if (!convexSiteUrl) {
    await logToScreenshotCollector(
      "[ERROR] convexSiteUrl is required for proxy-only screenshot collection."
    );
    throw new Error("convexSiteUrl is required for proxy-only screenshot collection.");
  }

  const devInstructions = (() => {
    const normalizedSetupScript = setupScript?.trim() ?? "";
    const fallbackSetupScript = [installCommand?.trim(), devCommand?.trim()]
      .filter(Boolean)
      .join("\n\n");
    const resolvedSetupScript = normalizedSetupScript || fallbackSetupScript;

    if (resolvedSetupScript) {
      return `
The user provided the following setup script (maintenance + dev combined). If no dev server is running, use this script to start it:
<setup_script>
${resolvedSetupScript}
</setup_script>`;
    }

    if (!installCommand && !devCommand) {
      return `
The user did not provide installation or dev commands. You will need to discover them by reading README.md, package.json, .devcontainer.json, or other configuration files.`;
    }
    const parts = ["The user provided the following commands:"];
    if (installCommand) {
      parts.push(`<install_command>\n${installCommand}\n</install_command>`);
    } else {
      parts.push(
        "(No install command provided - check README.md or package.json)"
      );
    }
    if (devCommand) {
      parts.push(`<dev_command>\n${devCommand}\n</dev_command>`);
    } else {
      parts.push(
        "(No dev command provided - check README.md or package.json)"
      );
    }
    return "\n" + parts.join("\n");
  })();

  const prompt = `You are a screenshot collector for pull request reviews. Your job is to determine if a PR contains UI changes and, if so, capture screenshots of those changes.

<PR_CONTEXT>
Title: ${prTitle}
Description: ${prDescription || "No description provided"}
Branch: ${branch}
Files changed:
${changedFiles.map((f) => `- ${f}`).join("\n")}
</PR_CONTEXT>

<ENVIRONMENT>
Working directory: ${workspaceDir}
Screenshot output directory: ${outputDir}
${devInstructions}
</ENVIRONMENT>

<PHASE_1_ANALYSIS>
First, analyze the changed files to determine if this PR contains UI changes.

IMPORTANT: Base your decision on the ACTUAL FILES CHANGED, not the PR title or description. PR descriptions can be misleading or incomplete. If the diff contains UI-affecting code, there ARE UI changes regardless of what the description says.

UI changes ARE present if the PR modifies code that affects what users see in the browser:
- Frontend components or templates (any framework: React, Vue, Rails ERB, PHP Blade, Django templates, etc.)
- Stylesheets (CSS, SCSS, Tailwind, styled-components, etc.)
- Markup or template files (HTML, JSX, ERB, Twig, Jinja, Handlebars, etc.)
- Client-side JavaScript/TypeScript that affects rendering
- UI states like loading indicators, error messages, empty states, or toasts
- Accessibility attributes, ARIA labels, or semantic markup

UI changes are NOT present if the PR only modifies:
- Server-side logic that doesn't change what's rendered (API handlers, database queries, background jobs)
- Configuration files (unless they affect theming or UI behavior)
- Tests, documentation, or build scripts
- Type definitions or interfaces for non-UI code

If no UI changes exist: Set hasUiChanges=false, take ZERO screenshots, and explain why. Do not start the dev server or open a browser.
</PHASE_1_ANALYSIS>

<PHASE_2_CAPTURE>
If UI changes exist, capture screenshots:

1. FIRST, check if the dev server is ALREADY RUNNING:
   - Run \`tmux list-windows\` and \`tmux capture-pane -p -t <window>\` to see running processes and their logs
   - Check if there's a dev server process starting up or already running in any tmux window
   - For cloud tasks, also inspect cmux-pty output/logs (tmux may not be used). Look for active dev server commands there.
   - The dev server is typically started automatically in this environment - BE PATIENT and monitor the logs
   - If you see the server is starting/compiling, WAIT for it to finish - do NOT kill it or restart it
   - Use \`ss -tlnp | grep LISTEN\` to see what ports have servers listening
2. ONLY if no server is running anywhere: Read CLAUDE.md, README.md, or package.json for setup instructions. Install dependencies if needed, then start the dev server.
3. BE PATIENT - servers can take time to compile. Monitor tmux logs to see progress. A response from curl (even 404) means the server is up. Do NOT restart the server if it's still compiling.
4. Navigate to the pages/components modified in the PR
5. Capture screenshots of the changes, including:
   - The default/resting state of changed components
   - Interactive states: hover, focus, active, disabled
   - Conditional states: loading, error, empty, success (if the PR modifies these!)
   - Hidden UI: modals, dropdowns, tooltips, accordions
   - Responsive layouts if the PR includes responsive changes
6. Save screenshots to ${outputDir} with descriptive names like "component-state-${branch}.png"
</PHASE_2_CAPTURE>

<PHASE_3_QUALITY_VERIFICATION>
After capturing screenshots, you MUST verify each one for quality. For EACH screenshot file in ${outputDir}:

1. OPEN the screenshot image file and visually inspect it
2. EVALUATE the screenshot against these quality criteria:
   - Does it show the intended UI component/page that the filename suggests?
   - Is the content fully loaded (no spinners, skeleton loaders, or partial renders - unless that IS the intended capture)?
   - Is the relevant UI element fully visible and not cut off?
   - Is the screenshot free of error states, console overlays, or dev tool artifacts (unless intentionally capturing those)?
   - Does it accurately represent the PR changes you intended to capture?

3. DECIDE: Is this a good screenshot?
   - GOOD: The screenshot clearly captures the intended UI state. Keep it.
   - BAD: The screenshot is blurry, shows wrong content, has unintended loading states, is cut off, or doesn't represent the PR changes. DELETE IT.

4. If BAD: Delete the screenshot file from the filesystem using \`rm <filepath>\`. Then either:
   - Retake the screenshot after fixing the issue (refresh page, wait for content to load, scroll to element, resize viewport)
   - Skip if the UI state cannot be reproduced

5. Only include screenshots in your final output that you have verified as GOOD quality.

Be ruthless about quality. A few excellent screenshots are far more valuable than many mediocre ones. Delete anything that doesn't clearly demonstrate the UI changes.
</PHASE_3_QUALITY_VERIFICATION>

<WHAT_TO_CAPTURE>
Screenshot the UI states that the PR actually modifies. Be intentional:

- If the PR changes a loading spinner → screenshot the loading state
- If the PR changes error handling UI → screenshot the error state
- If the PR changes a skeleton loader → screenshot the skeleton
- If the PR changes hover styles → screenshot the hover state
- If the PR changes a modal → open and screenshot the modal

Don't screenshot loading/error states incidentally while waiting for the "real" UI. Screenshot them when they ARE the change.
</WHAT_TO_CAPTURE>

<CRITICAL_MISTAKES>
Avoid these failure modes:

FALSE POSITIVE: Taking screenshots when the PR has no UI changes. Backend-only, config, or test changes = hasUiChanges=false, zero screenshots.

FALSE NEGATIVE: Failing to capture screenshots when UI changes exist. If React components, CSS, or templates changed, you MUST capture them.

FAKE UI: Creating mock HTML files instead of screenshotting the real app. Never fabricate UIs. If the dev server won't start, report the failure.

WRONG PAGE: Screenshotting pages unrelated to the PR. Only capture components/pages that the changed files actually render.

DUPLICATE SCREENSHOTS: Taking multiple identical screenshots. Each screenshot should show something distinct.

INCOMPLETE CAPTURE: Missing important UI elements. Ensure full components are visible and not cut off.
</CRITICAL_MISTAKES>

<VIDEO_RECORDING>
Record screen videos to demonstrate workflows. Cursor overlay is added automatically in post-processing.

YOU MUST RECORD A VIDEO IF:
- There is a button, link, or clickable element
- There is navigation or page transitions
- There is any UI flow or state change
- The PR adds/modifies interactive elements

Screenshots alone are NOT enough for interactive changes - you MUST record a video showing the interaction.

SKIP VIDEO ONLY FOR: pure styling changes (colors, fonts, spacing), static text-only changes

STEP 1 - START RECORDING:
\`\`\`bash
DISPLAY=:1 ffmpeg -y -f x11grab -draw_mouse 0 -framerate 24 -video_size 1920x1080 -i :1+0,0 -c:v libx264 -preset ultrafast -crf 26 -pix_fmt yuv420p "${outputDir}/raw.mp4" &
FFMPEG_PID=$!
sleep 0.3
\`\`\`

STEP 2 - CLICK ELEMENTS:
For each click, you MUST:
1. First, get the element's bounding rect via Chrome MCP evaluate: \`element.getBoundingClientRect()\`
2. Then click the element

This ensures the cursor position is captured in the trajectory for the video overlay.
The cursor starts at screen center and animates to your first click, then follows subsequent clicks.

STEP 3 - STOP RECORDING:
\`\`\`bash
kill -INT $FFMPEG_PID
wait $FFMPEG_PID 2>/dev/null || true
\`\`\`
After the last click, just STOP. Do not sleep to "wait for page to load" - kill ffmpeg immediately.

⚠️⚠️⚠️ CRITICAL - NEVER CALL list_pages OR select_page AFTER CLICKING ⚠️⚠️⚠️
The video records the X11 SCREEN directly. When you click:
- The result is ALREADY being recorded on screen
- Do NOT call list_pages or select_page - just click → kill ffmpeg → done
This is NON-NEGOTIABLE.

STEP 4 - POST-PROCESS (adds cursor overlay automatically):
\`\`\`bash
python3 << PYSCRIPT
import subprocess, os, sys, json

outdir = "${outputDir}"
events_log_path = f"{outdir}/events.log"

# Parse events.log for bounding_rect and pretool events
# The pretool hook calls CDP to get bounding rect when it sees a tool with uid
clicks = []  # list of (timestamp_ms, x, y)
recording_start_ms = None
last_bounding_rect = None  # (x, y) screen coordinates from most recent bounding_rect event

print(f"Reading events from {events_log_path}", file=sys.stderr)

# Parse events.log
line_count = 0
try:
    with open(events_log_path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            line_count += 1
            event = json.loads(line)
            ts = event.get("timestamp", 0)
            event_type = event.get("event", "")

            # Detect recording start (logged when ffmpeg starts)
            if event_type == "recording_start":
                if recording_start_ms is None:
                    recording_start_ms = ts
                    print(f"Found recording start at {ts}", file=sys.stderr)

            # Bounding rect from CDP (logged by pretool hook)
            elif event_type == "bounding_rect":
                x = event.get("x", 0)
                y = event.get("y", 0)
                w = event.get("width", 0)
                h = event.get("height", 0)
                # Compute center and add browser chrome offset (85px)
                screen_x = int(x + w/2)
                screen_y = int(y + h/2 + 85)
                last_bounding_rect = (screen_x, screen_y, ts)
                print(f"bounding_rect: ({x},{y},{w},{h}) -> center=({screen_x}, {screen_y})", file=sys.stderr)

            # Click event (logged by pretool hook)
            elif event_type == "pretool":
                tool_name = event.get("tool", "").lower()
                uid = event.get("uid", "")
                if "click" in tool_name:
                    if last_bounding_rect:
                        clicks.append((ts, last_bounding_rect[0], last_bounding_rect[1]))
                        print(f"click (uid={uid}) at ({last_bounding_rect[0]}, {last_bounding_rect[1]}) ts={ts}", file=sys.stderr)
                    else:
                        print(f"WARNING: click without bounding_rect, tool={tool_name}, uid={uid}", file=sys.stderr)

    print(f"Processed {line_count} events", file=sys.stderr)
except FileNotFoundError:
    print(f"ERROR: events.log not found: {events_log_path}", file=sys.stderr)
except Exception as e:
    print(f"ERROR reading events.log: {e}", file=sys.stderr)

print(f"Found {len(clicks)} clicks", file=sys.stderr)

# Convert timestamps to relative time from first click (cursor starts at center)
if clicks:
    first_ts = clicks[0][0]
    # All clicks relative to first click, starting at t=0.5s (gives time for animation from center)
    clicks = [(0.5 + (ts - first_ts) / 1000.0, x, y) for ts, x, y in clicks]
    print(f"Adjusted clicks: {clicks}", file=sys.stderr)

if clicks:
    filters = []

    # Cursor starts at screen center and animates to first click position
    cx, cy = 960, 540  # screen center
    first_t, first_x, first_y = clicks[0]
    anim_dur = max(first_t, 0.1)  # animation ends at first click (at least 0.1s)

    print(f"Animation: center ({cx},{cy}) -> ({first_x},{first_y}) over {anim_dur:.2f}s", file=sys.stderr)

    yellow_x_expr = f"({cx-14}+({first_x-14}-{cx-14})*min(t/{anim_dur},1))"
    yellow_y_expr = f"({cy-20}+({first_y-20}-{cy-20})*min(t/{anim_dur},1))"
    black_x_expr = f"({cx-3}+({first_x-3}-{cx-3})*min(t/{anim_dur},1))"
    black_y_expr = f"({cy-8}+({first_y-8}-{cy-8})*min(t/{anim_dur},1))"

    # Animation phase - cursor moves from center to first click
    filters.append(f"drawtext=text='●':x='{yellow_x_expr}':y='{yellow_y_expr}':fontsize=36:fontcolor=yellow@0.5:enable='between(t,0,{anim_dur:.2f})'")
    filters.append(f"drawtext=text='●':x='{black_x_expr}':y='{black_y_expr}':fontsize=12:fontcolor=black:enable='between(t,0,{anim_dur:.2f})'")

    # Static cursor at each click position
    for i, (t, x, y) in enumerate(clicks):
        end_t = clicks[i+1][0] if i+1 < len(clicks) else 9999
        if end_t <= t:
            continue
        e = f"enable='between(t,{t:.2f},{end_t:.2f})'"
        filters.append(f"drawtext=text='●':x={x-14}:y={y-20}:fontsize=36:fontcolor=yellow@0.5:{e}")
        filters.append(f"drawtext=text='●':x={x-3}:y={y-8}:fontsize=12:fontcolor=black:{e}")

    filter_str = ",".join(filters) + ",setpts=0.5*PTS"
    print(f"Running ffmpeg with {len(filters)} filter elements + 2x speed", file=sys.stderr)
    result = subprocess.run(f'ffmpeg -y -i "{outdir}/raw.mp4" -vf "{filter_str}" "{outdir}/workflow.mp4"', shell=True)
    if result.returncode == 0:
        os.remove(f"{outdir}/raw.mp4")
    else:
        print(f"ffmpeg failed with code {result.returncode}", file=sys.stderr)
        os.rename(f"{outdir}/raw.mp4", f"{outdir}/workflow.mp4")
else:
    print("No clicks found, speeding up raw video 2x", file=sys.stderr)
    result = subprocess.run(f'ffmpeg -y -i "{outdir}/raw.mp4" -vf "setpts=0.5*PTS" "{outdir}/workflow.mp4"', shell=True)
    if result.returncode == 0:
        os.remove(f"{outdir}/raw.mp4")
    else:
        os.rename(f"{outdir}/raw.mp4", f"{outdir}/workflow.mp4")
PYSCRIPT
\`\`\`

IMPORTANT:
- CLICK elements, not hover - show the full interaction flow
- Kill ffmpeg immediately when result is visible
- NEVER call list_pages or select_page after clicking
- After last click: kill ffmpeg → run post-process. Done.
</VIDEO_RECORDING>

<OUTPUT>
When you are finished, leave the browser open and briefly state what you captured.
Do not create summary documents.
</OUTPUT>`;

  await logToScreenshotCollector(
    `Starting Claude Agent with browser MCP for branch: ${branch}`
  );

  const screenshotPaths: string[] = [];
  const videoPaths: string[] = [];

  // Convert .convex.cloud to .convex.site for HTTP endpoints
  // HTTP routes are served from .convex.site, not .convex.cloud
  const normalizedConvexSiteUrl = formatOptionalValue(convexSiteUrl)
    .replace(".convex.cloud", ".convex.site");

  await logToScreenshotCollector(
    `[DEBUG] convexSiteUrl (original): ${formatOptionalValue(convexSiteUrl)}`
  );
  await logToScreenshotCollector(
    `[DEBUG] convexSiteUrl (normalized): ${normalizedConvexSiteUrl}`
  );

  const anthropicBaseUrl = `${normalizedConvexSiteUrl}/api/anthropic`;

  await logToScreenshotCollector(
    `[DEBUG] anthropicBaseUrl: ${anthropicBaseUrl}`
  );

  try {
    const hadOriginalApiKey = Object.prototype.hasOwnProperty.call(
      process.env,
      "ANTHROPIC_API_KEY"
    );
    const originalApiKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;

    // Also delete OAuth token from process.env BEFORE creating claudeEnv
    // This prevents Claude Code from bypassing ANTHROPIC_BASE_URL
    const hadOriginalOAuthToken = Object.prototype.hasOwnProperty.call(
      process.env,
      "CLAUDE_CODE_OAUTH_TOKEN"
    );
    const originalOAuthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    // Log JWT info for debugging
    await logToScreenshotCollector(
      `Using taskRun JWT auth. JWT present: ${!!auth.taskRunJwt}, JWT length: ${auth.taskRunJwt?.length ?? 0}, JWT first 20 chars: ${auth.taskRunJwt?.substring(0, 20) ?? "N/A"}`
    );
    await logToScreenshotCollector(
      `[DEBUG] Removed from process.env before creating claudeEnv: ANTHROPIC_API_KEY=${hadOriginalApiKey ? "was present" : "was not present"}, CLAUDE_CODE_OAUTH_TOKEN=${hadOriginalOAuthToken ? "was present (BYPASSES PROXY!)" : "was not present"}`
    );
    await logToScreenshotCollector(`ANTHROPIC_BASE_URL: ${anthropicBaseUrl}`);
    await logToScreenshotCollector(
      `[DEBUG] ANTHROPIC_CUSTOM_HEADERS will be: x-cmux-token:<jwt>`
    );

    await logToScreenshotCollector(
      `Arguments to Claude Code: ${JSON.stringify({
        prompt,
        cwd: workspaceDir,
        pathToClaudeCodeExecutable: options.pathToClaudeCodeExecutable,
      })}`
    );

    const claudeEnv: NodeJS.ProcessEnv = {
      ...process.env,
      IS_SANDBOX: "1",
      // Don't set CLAUDE_CONFIG_DIR - we use settingSources: [] to ignore config files
      CLAUDE_CODE_ENABLE_TELEMETRY: "0",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      // Ensure HOME and USER are set (required by Claude CLI, may be missing in sandbox)
      HOME: process.env.HOME || "/root",
      USER: process.env.USER || "root",
    };

    // Remove environment variables that may interfere with our configured auth path.
    // CLAUDE_CODE_OAUTH_TOKEN: If present, Claude Code may bypass ANTHROPIC_BASE_URL and go direct to Anthropic.
    // AWS_*: These can cause Claude Code to use Bedrock directly instead of our proxy.
    // ANTHROPIC_MODEL/SMALL_FAST_MODEL: We want Claude Code to use its defaults, not inherited values.
    delete claudeEnv.CLAUDE_CODE_OAUTH_TOKEN;
    delete claudeEnv.AWS_BEARER_TOKEN_BEDROCK;
    delete claudeEnv.CLAUDE_CODE_USE_BEDROCK;
    delete claudeEnv.ANTHROPIC_MODEL;
    delete claudeEnv.ANTHROPIC_SMALL_FAST_MODEL;
    // Remove AWS credentials that could cause Claude Code to bypass our proxy
    delete claudeEnv.AWS_ACCESS_KEY_ID;
    delete claudeEnv.AWS_SECRET_ACCESS_KEY;
    delete claudeEnv.AWS_SESSION_TOKEN;
    delete claudeEnv.AWS_REGION;
    delete claudeEnv.AWS_DEFAULT_REGION;
    delete claudeEnv.AWS_PROFILE;

    // Configure proxy auth via env vars (works both locally and in sandbox)
    // We use settingSources: [] to ignore user/project settings, so env vars take precedence
    const customHeaders = `x-cmux-token:${auth.taskRunJwt}\nx-cmux-source:screenshot-collector`;

    // Unset any conflicting auth variables first
    for (const envVar of CLAUDE_KEY_ENV_VARS_TO_UNSET) {
      delete claudeEnv[envVar];
    }

    // Set proxy env vars
    claudeEnv.ANTHROPIC_BASE_URL = anthropicBaseUrl;
    claudeEnv.ANTHROPIC_CUSTOM_HEADERS = customHeaders;
    claudeEnv.ANTHROPIC_API_KEY = CMUX_ANTHROPIC_PROXY_PLACEHOLDER_API_KEY;

    await logToScreenshotCollector(
      `[DEBUG] Using env vars for proxy routing (settingSources: [] ignores user config)`
    );

    // Log process.env for debugging sandbox vs local differences (FULL VALUES for debugging)
    const relevantEnvVars = [
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_BASE_URL",
      "ANTHROPIC_CUSTOM_HEADERS",
      "ANTHROPIC_AUTH_TOKEN",
      "CLAUDE_API_KEY",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "CLAUDE_CONFIG_DIR",
      "AWS_BEARER_TOKEN_BEDROCK",
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
      "AWS_SESSION_TOKEN",
      "AWS_REGION",
      "AWS_DEFAULT_REGION",
      "CLAUDE_CODE_USE_BEDROCK",
      "HOME",
      "USER",
    ];
    const processEnvSnapshot: Record<string, string> = {};
    for (const key of relevantEnvVars) {
      const val = process.env[key];
      processEnvSnapshot[key] = val ?? "<unset>";
    }
    await logToScreenshotCollector(
      `[DEBUG] process.env (before query): ${JSON.stringify(processEnvSnapshot, null, 2)}`
    );

    await logToScreenshotCollector(
      `[DEBUG] claudeEnv passed to query(): ${JSON.stringify({
        ANTHROPIC_BASE_URL: claudeEnv.ANTHROPIC_BASE_URL ?? "<unset>",
        ANTHROPIC_CUSTOM_HEADERS: claudeEnv.ANTHROPIC_CUSTOM_HEADERS ?? "<unset>",
        ANTHROPIC_API_KEY: claudeEnv.ANTHROPIC_API_KEY ?? "<unset>",
        CLAUDE_CODE_OAUTH_TOKEN: claudeEnv.CLAUDE_CODE_OAUTH_TOKEN ?? "<unset>",
        CLAUDE_CONFIG_DIR: claudeEnv.CLAUDE_CONFIG_DIR ?? "<unset>",
        HOME: claudeEnv.HOME ?? "<unset>",
        USER: claudeEnv.USER ?? "<unset>",
      }, null, 2)}`
    );

    await logToScreenshotCollector(
      `[DEBUG] JWT token being used: ${auth.taskRunJwt}`
    );

    let detectedHasUiChanges: boolean | undefined;

    // Write trajectory to JSONL file for post-processing (video cursor overlay)
    const trajectoryPath = path.join(outputDir, "trajectory.jsonl");
    const trajectoryStream = await fs.open(trajectoryPath, "w");

    // Events log for pretool hook - logs tool calls with uid and bounding rects
    const eventsLogPath = path.join(outputDir, EVENTS_LOG_FILENAME);
    // Clear/create events.log at start
    await fs.writeFile(eventsLogPath, "");

    try {
      for await (const message of query({
        prompt,
        options: {
          model: "claude-opus-4-5-20251101",
          mcpServers: {
            chrome: {
              command: "bunx",
              args: [
                "chrome-devtools-mcp",
                "--browserUrl",
                "http://0.0.0.0:39382",
              ],
            },
          },
          allowDangerouslySkipPermissions: true,
          permissionMode: "bypassPermissions",
          cwd: workspaceDir,
          pathToClaudeCodeExecutable: options.pathToClaudeCodeExecutable,
          // Empty array = SDK isolation mode, disables loading user/project settings
          // This ensures env vars (ANTHROPIC_BASE_URL, etc.) are used instead of ~/.claude/settings.json
          settingSources: [],
          env: claudeEnv,
          stderr: (data) =>
            logToScreenshotCollector(`[claude-code-stderr] ${data}`),
        },
      })) {
        // Write message to trajectory JSONL with timestamp
        const timestamp = Date.now();
        const trajectoryEntry = {
          timestamp,
          message,
        };
        await trajectoryStream.write(JSON.stringify(trajectoryEntry) + "\n");

        // PRETOOL HOOK: When we see a tool_use with uid, call CDP to get bounding rect
        // This captures cursor position BEFORE the click happens
        if (message.type === "assistant") {
          const content = message.message?.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (
                block &&
                typeof block === "object" &&
                "type" in block &&
                block.type === "tool_use" &&
                "name" in block
              ) {
                const toolName = String(block.name);
                const toolNameLower = toolName.toLowerCase();
                const input = "input" in block && block.input && typeof block.input === "object"
                  ? block.input as Record<string, unknown>
                  : {};
                const uid = typeof input.uid === "string" ? input.uid : undefined;

                const isClickTool = toolNameLower.includes("click");

                // If we have a uid, call CDP to get bounding rect
                if (uid) {
                  try {
                    const rect = await getBoundingRectFromCDP(uid);
                    if (rect) {
                      // Log bounding_rect event FIRST (before pretool)
                      await fs.appendFile(
                        eventsLogPath,
                        JSON.stringify({
                          timestamp,
                          event: "bounding_rect",
                          ...rect,
                          uid,
                        }) + "\n"
                      );

                      await logToScreenshotCollector(
                        `[PRETOOL] Got bounding rect for uid=${uid}: x=${rect.x}, y=${rect.y}, w=${rect.width}, h=${rect.height}`
                      );
                    } else {
                      await logToScreenshotCollector(
                        `[PRETOOL] Could not get bounding rect for uid=${uid}`
                      );
                    }
                  } catch (cdpError) {
                    await logToScreenshotCollector(
                      `[PRETOOL] CDP error for uid=${uid}: ${cdpError instanceof Error ? cdpError.message : String(cdpError)}`
                    );
                  }
                }

                // Log pretool event for click tools
                if (isClickTool) {
                  await fs.appendFile(
                    eventsLogPath,
                    JSON.stringify({
                      timestamp,
                      event: "pretool",
                      tool: toolName,
                      ...(uid ? { uid } : {}),
                    }) + "\n"
                  );

                  await logToScreenshotCollector(
                    `[PRETOOL] Click: ${toolName}${uid ? ` uid=${uid}` : ""}`
                  );
                }
              }
            }
          }
        }

        // Format and log all message types
        const formatted = formatClaudeMessage(message);
        if (formatted) {
          await logToScreenshotCollector(formatted);
        }

        // Extract hasUiChanges from result message
        if (message.type === "result") {
          await logToScreenshotCollector(
            `[DEBUG] Full result message: ${JSON.stringify(message, null, 2)}`
          );

          // Try to parse hasUiChanges from the result text
          // Claude may express this as "hasUiChanges=false", "hasUiChanges: false", or in JSON
          if ("result" in message && typeof message.result === "string") {
            const resultText = message.result.toLowerCase();
            // Check for explicit false indicators
            if (
              resultText.includes("hasuichanges=false") ||
              resultText.includes("hasuichanges: false") ||
              resultText.includes("hasuichanges\":false") ||
              resultText.includes("hasuichanges\": false") ||
              resultText.includes("no ui changes") ||
              resultText.includes("no visual changes") ||
              resultText.includes("backend-only") ||
              resultText.includes("does not contain ui changes")
            ) {
              detectedHasUiChanges = false;
              await logToScreenshotCollector(
                `[DEBUG] Detected hasUiChanges=false from result text`
              );
            } else if (
              resultText.includes("hasuichanges=true") ||
              resultText.includes("hasuichanges: true") ||
              resultText.includes("hasuichanges\":true") ||
              resultText.includes("hasuichanges\": true") ||
              resultText.includes("captured") ||
              resultText.includes("screenshot")
            ) {
              detectedHasUiChanges = true;
              await logToScreenshotCollector(
                `[DEBUG] Detected hasUiChanges=true from result text`
              );
            }
          }
        }
      }
    } catch (error) {
      await logToScreenshotCollector(
        `Failed to capture screenshots with Claude Agent: ${error instanceof Error ? error.message : String(error)}`
      );
      log("ERROR", "Failed to capture screenshots with Claude Agent", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      // Close trajectory stream
      await trajectoryStream.close();

      // Restore original API key
      if (hadOriginalApiKey) {
        if (originalApiKey !== undefined) {
          process.env.ANTHROPIC_API_KEY = originalApiKey;
        } else {
          delete process.env.ANTHROPIC_API_KEY;
        }
      } else {
        delete process.env.ANTHROPIC_API_KEY;
      }
      // Restore original OAuth token
      if (hadOriginalOAuthToken) {
        if (originalOAuthToken !== undefined) {
          process.env.CLAUDE_CODE_OAUTH_TOKEN = originalOAuthToken;
        } else {
          delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
        }
      } else {
        delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      }
    }

    // Find all screenshot and video files in the output directory
    try {
      const { screenshots, videos, hasNestedDirectories } =
        await collectMediaFiles(outputDir);

      if (hasNestedDirectories) {
        await logToScreenshotCollector(
          `Detected nested media folders under ${outputDir}. Please keep all screenshots and videos directly in the output directory.`
        );
      }

      const uniqueScreens = Array.from(
        new Set(screenshots.map((filePath) => path.normalize(filePath)))
      ).sort();
      screenshotPaths.push(...uniqueScreens);

      const uniqueVideos = Array.from(
        new Set(videos.map((filePath) => path.normalize(filePath)))
      ).sort();
      videoPaths.push(...uniqueVideos);
    } catch (readError) {
      log("WARN", "Could not read output directory", {
        outputDir,
        error:
          readError instanceof Error ? readError.message : String(readError),
      });
    }

    const screenshotsWithDescriptions = screenshotPaths.map((absolutePath) => {
      return {
        path: absolutePath,
      };
    });

    const videosWithDescriptions = videoPaths.map((absolutePath) => {
      return {
        path: absolutePath,
      };
    });

    // Determine hasUiChanges:
    // 1. Use explicitly detected value from Claude's result
    // 2. If we have screenshots/videos, UI changes exist
    // 3. Otherwise, leave undefined (caller can decide)
    let finalHasUiChanges = detectedHasUiChanges;
    if (finalHasUiChanges === undefined && (screenshotsWithDescriptions.length > 0 || videosWithDescriptions.length > 0)) {
      finalHasUiChanges = true;
      await logToScreenshotCollector(
        `[DEBUG] Inferred hasUiChanges=true because screenshots/videos were captured`
      );
    }

    await logToScreenshotCollector(
      `[DEBUG] Final hasUiChanges: ${finalHasUiChanges}, screenshots: ${screenshotsWithDescriptions.length}, videos: ${videosWithDescriptions.length}`
    );

    return {
      screenshots: screenshotsWithDescriptions,
      videos: videosWithDescriptions,
      hasUiChanges: finalHasUiChanges,
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : String(error ?? "unknown error");
    await logToScreenshotCollector(
      `Failed to capture screenshots with Claude Agent: ${message}`
    );

    // Log full error details for debugging
    if (error instanceof Error) {
      if (error.stack) {
        await logToScreenshotCollector(`Stack trace: ${error.stack}`);
      }
      // Log any additional error properties
      const errorObj = error as Error & Record<string, unknown>;
      const additionalProps = Object.keys(errorObj)
        .filter((key) => !["message", "stack", "name"].includes(key))
        .map((key) => `${key}: ${JSON.stringify(errorObj[key])}`)
        .join(", ");
      if (additionalProps) {
        await logToScreenshotCollector(`Error details: ${additionalProps}`);
      }
    }

    throw error;
  }
}

/**
 * Capture screenshots for a PR
 * Assumes the workspace directory is already set up with git repo cloned
 */
export async function claudeCodeCapturePRScreenshots(
  options: CaptureScreenshotsOptions
): Promise<ScreenshotResult> {
  const {
    workspaceDir,
    changedFiles,
    prTitle,
    prDescription,
    baseBranch,
    headBranch,
    outputDir: requestedOutputDir,
    auth,
  } = options;
  const outputDir = normalizeScreenshotOutputDir(requestedOutputDir);

  try {
    await logToScreenshotCollector(
      `Starting PR screenshot capture in ${workspaceDir}`
    );

    if (changedFiles.length === 0) {
      const reason = "No files changed in PR";
      await logToScreenshotCollector(reason);
      return { status: "skipped", reason };
    }

    await logToScreenshotCollector(
      `Found ${changedFiles.length} changed files: ${changedFiles.join(", ")}`
    );

    await fs.mkdir(outputDir, { recursive: true });

    const allScreenshots: { path: string; description?: string }[] = [];
    const allVideos: { path: string; description?: string }[] = [];
    let hasUiChanges: boolean | undefined;

    const CAPTURE_BEFORE = false;

    if (CAPTURE_BEFORE) {
      // Capture screenshots for base branch (before changes)
      await logToScreenshotCollector(
        `Capturing 'before' screenshots for base branch: ${baseBranch}`
      );
      const beforeCapture = await captureScreenshotsForBranch(
        isTaskRunJwtAuth(auth)
          ? {
            workspaceDir,
            changedFiles,
            prTitle,
            prDescription,
            branch: baseBranch,
            outputDir,
            auth: { taskRunJwt: auth.taskRunJwt },
            pathToClaudeCodeExecutable: options.pathToClaudeCodeExecutable,
            setupScript: options.setupScript,
            installCommand: options.installCommand,
            devCommand: options.devCommand,
            convexSiteUrl: options.convexSiteUrl,
          }
          : {
            workspaceDir,
            changedFiles,
            prTitle,
            prDescription,
            branch: baseBranch,
            outputDir,
            auth: { anthropicApiKey: auth.anthropicApiKey },
            pathToClaudeCodeExecutable: options.pathToClaudeCodeExecutable,
            setupScript: options.setupScript,
            installCommand: options.installCommand,
            devCommand: options.devCommand,
            convexSiteUrl: options.convexSiteUrl,
          }
      );
      allScreenshots.push(...beforeCapture.screenshots);
      allVideos.push(...beforeCapture.videos);
      if (beforeCapture.hasUiChanges !== undefined) {
        hasUiChanges = beforeCapture.hasUiChanges;
      }
      await logToScreenshotCollector(
        `Captured ${beforeCapture.screenshots.length} 'before' screenshots and ${beforeCapture.videos.length} videos`
      );
    }

    // Capture screenshots for head branch (after changes)
    await logToScreenshotCollector(
      `Capturing 'after' screenshots for head branch: ${headBranch}`
    );
    const afterCapture = await captureScreenshotsForBranch(
      isTaskRunJwtAuth(auth)
        ? {
          workspaceDir,
          changedFiles,
          prTitle,
          prDescription,
          branch: headBranch,
          outputDir,
          auth: { taskRunJwt: auth.taskRunJwt },
          pathToClaudeCodeExecutable: options.pathToClaudeCodeExecutable,
          setupScript: options.setupScript,
          installCommand: options.installCommand,
          devCommand: options.devCommand,
          convexSiteUrl: options.convexSiteUrl,
        }
        : {
          workspaceDir,
          changedFiles,
          prTitle,
          prDescription,
          branch: headBranch,
          outputDir,
          auth: { anthropicApiKey: auth.anthropicApiKey },
          pathToClaudeCodeExecutable: options.pathToClaudeCodeExecutable,
          setupScript: options.setupScript,
          installCommand: options.installCommand,
          devCommand: options.devCommand,
          convexSiteUrl: options.convexSiteUrl,
        }
    );
    allScreenshots.push(...afterCapture.screenshots);
    allVideos.push(...afterCapture.videos);
    if (afterCapture.hasUiChanges !== undefined) {
      hasUiChanges = afterCapture.hasUiChanges;
    }
    await logToScreenshotCollector(
      `Captured ${afterCapture.screenshots.length} 'after' screenshots and ${afterCapture.videos.length} videos`
    );

    await logToScreenshotCollector(
      `Capture completed. Total: ${allScreenshots.length} screenshots, ${allVideos.length} videos saved to ${outputDir}`
    );
    log("INFO", "PR capture completed", {
      screenshotCount: allScreenshots.length,
      videoCount: allVideos.length,
      outputDir,
    });

    return {
      status: "completed",
      screenshots: allScreenshots,
      videos: allVideos,
      hasUiChanges,
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : String(error ?? "unknown error");
    await logToScreenshotCollector(`PR screenshot capture failed: ${message}`);
    log("ERROR", "PR screenshot capture failed", {
      error: message,
    });
    return {
      status: "failed",
      error: message,
    };
  }
}

// Re-export utilities
export { logToScreenshotCollector } from "./logger";
export { formatClaudeMessage } from "./claudeMessageFormatter";

// CLI entry point - runs when executed directly
const cliOptionsSchema = z.object({
  workspaceDir: z.string(),
  changedFiles: z.array(z.string()),
  prTitle: z.string(),
  prDescription: z.string(),
  baseBranch: z.string(),
  headBranch: z.string(),
  outputDir: z.string(),
  pathToClaudeCodeExecutable: z.string().optional(),
  setupScript: z.string().optional(),
  installCommand: z.string().optional(),
  devCommand: z.string().optional(),
  convexSiteUrl: z.string().optional(),
  auth: z.union([
    z.object({ taskRunJwt: z.string() }),
    z.object({ anthropicApiKey: z.string() }),
  ]),
});

async function main() {
  const optionsJson = process.env.SCREENSHOT_OPTIONS;
  if (!optionsJson) {
    console.error("SCREENSHOT_OPTIONS environment variable is required");
    process.exit(1);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(optionsJson);
  } catch (error) {
    console.error("Failed to parse SCREENSHOT_OPTIONS as JSON:", error);
    process.exit(1);
  }

  const validated = cliOptionsSchema.safeParse(parsed);
  if (!validated.success) {
    console.error("Invalid SCREENSHOT_OPTIONS:", validated.error.format());
    process.exit(1);
  }

  const options = validated.data;
  const result = await claudeCodeCapturePRScreenshots(options as CaptureScreenshotsOptions);

  // Output result as JSON to stdout
  console.log(JSON.stringify(result));
}

// Check if running as CLI (not imported as module)
// Only run as CLI if SCREENSHOT_OPTIONS env var is set - this is the definitive signal
// that we're being run as a CLI, not imported as a module
const shouldRunAsCli = !!process.env.SCREENSHOT_OPTIONS;

if (shouldRunAsCli) {
  main().catch((error) => {
    console.error("CLI execution failed:", error);
    process.exit(1);
  });
}
