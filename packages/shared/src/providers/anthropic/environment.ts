import type {
  EnvironmentContext,
  EnvironmentResult,
} from "../common/environment-result";
import { CMUX_ANTHROPIC_PROXY_PLACEHOLDER_API_KEY } from "../../utils/anthropic";

export const CLAUDE_KEY_ENV_VARS_TO_UNSET = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_CUSTOM_HEADERS",
  "CLAUDE_API_KEY",
];

export async function getClaudeEnvironment(
  ctx: EnvironmentContext,
): Promise<EnvironmentResult> {
  // These must be lazy since configs are imported into the browser
  // const { exec } = await import("node:child_process");
  // const { promisify } = await import("node:util");
  const { readFile } = await import("node:fs/promises");
  const { homedir } = await import("node:os");
  const { Buffer } = await import("node:buffer");
  // const execAsync = promisify(exec);

  const files: EnvironmentResult["files"] = [];
  const env: Record<string, string> = {};
  const startupCommands: string[] = [];
  const claudeLifecycleDir = "/root/lifecycle/claude";
  const claudeSecretsDir = `${claudeLifecycleDir}/secrets`;
  const claudeApiKeyHelperPath = `${claudeSecretsDir}/anthropic_key_helper.sh`;

  // Prepare .claude.json
  try {
    // Try to read existing .claude.json, or create a new one
    let existingConfig = {};
    try {
      const content = await readFile(`${homedir()}/.claude.json`, "utf-8");
      existingConfig = JSON.parse(content);
    } catch {
      // File doesn't exist or is invalid, start fresh
    }

    const config = {
      ...existingConfig,
      projects: {
        "/root/workspace": {
          allowedTools: [],
          history: [],
          mcpContextUris: [],
          mcpServers: ctx.iosResourceAllocationId
            ? {
                ios: {
                  command: "node",
                  args: ["/root/lifecycle/mcp/ios-resource-proxy.mjs"],
                  env: {
                    CMUX_MCP_PROXY_URL: `${ctx.callbackUrl}/api/resource-providers/allocations/${ctx.iosResourceAllocationId}/mcp`,
                    CMUX_TASK_RUN_JWT: ctx.taskRunJwt,
                  },
                },
              }
            : {},
          enabledMcpjsonServers: [],
          disabledMcpjsonServers: [],
          hasTrustDialogAccepted: true,
          projectOnboardingSeenCount: 0,
          hasClaudeMdExternalIncludesApproved: false,
          hasClaudeMdExternalIncludesWarningShown: false,
        },
      },
      isQualifiedForDataSharing: false,
      hasCompletedOnboarding: true,
      bypassPermissionsModeAccepted: true,
      hasAcknowledgedCostThreshold: true,
    };

    // Write to ~/.claude/.claude.json (the canonical location Claude Code checks)
    files.push({
      destinationPath: "$HOME/.claude/.claude.json",
      contentBase64: Buffer.from(JSON.stringify(config, null, 2)).toString(
        "base64",
      ),
      mode: "644",
    });
  } catch (error) {
    console.warn("Failed to prepare .claude.json:", error);
  }

  // // Try to get credentials and prepare .credentials.json
  // let credentialsAdded = false;
  // try {
  //   // First try Claude Code-credentials (preferred)
  //   const execResult = await execAsync(
  //     "security find-generic-password -a $USER -w -s 'Claude Code-credentials'",
  //   );
  //   const credentialsText = execResult.stdout.trim();

  //   // Validate that it's valid JSON with claudeAiOauth
  //   const credentials = JSON.parse(credentialsText);
  //   if (credentials.claudeAiOauth) {
  //     files.push({
  //       destinationPath: "$HOME/.claude/.credentials.json",
  //       contentBase64: Buffer.from(credentialsText).toString("base64"),
  //       mode: "600",
  //     });
  //     credentialsAdded = true;
  //   }
  // } catch {
  //   // noop
  // }

  // // If no credentials file was created, try to use API key via helper script (avoid env var to prevent prompts)
  // if (!credentialsAdded) {
  //   try {
  //     const execResult = await execAsync(
  //       "security find-generic-password -a $USER -w -s 'Claude Code'",
  //     );
  //     const apiKey = execResult.stdout.trim();

  //     // Write the key to a persistent location with strict perms
  //     files.push({
  //       destinationPath: claudeApiKeyPath,
  //       contentBase64: Buffer.from(apiKey).toString("base64"),
  //       mode: "600",
  //     });
  //     credentialsAdded = true;
  //   } catch {
  //     console.warn("No Claude API key found in keychain");
  //   }
  // }

  // Add iOS resource MCP proxy if allocation is present
  if (ctx.iosResourceAllocationId) {
    const { readFileSync } = await import("node:fs");
    const { resolve, dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");

    try {
      // Read the proxy script from the shared package
      const proxyScriptPath = resolve(
        dirname(fileURLToPath(import.meta.url)),
        "../mcp/ios-resource-proxy.mjs",
      );
      const proxyScript = readFileSync(proxyScriptPath, "utf-8");

      files.push({
        destinationPath: "/root/lifecycle/mcp/ios-resource-proxy.mjs",
        contentBase64: Buffer.from(proxyScript).toString("base64"),
        mode: "755",
      });
    } catch (error) {
      console.error("Failed to read iOS resource proxy script:", error);
    }
  }

  // Ensure directories exist
  startupCommands.unshift("mkdir -p ~/.claude");
  // Symlink ~/.claude.json → ~/.claude/.claude.json so Claude Code finds it
  startupCommands.push("ln -sf ~/.claude/.claude.json ~/.claude.json");
  startupCommands.push(`mkdir -p ${claudeLifecycleDir}`);
  if (ctx.iosResourceAllocationId) {
    startupCommands.push("mkdir -p /root/lifecycle/mcp");
  }
  startupCommands.push(`mkdir -p ${claudeSecretsDir}`);

  // Clean up any previous Claude completion markers
  // This should run before the agent starts to ensure clean state
  startupCommands.push(
    "rm -f /root/lifecycle/claude-complete-* 2>/dev/null || true",
  );

  // Create the stop hook script in /root/lifecycle (outside git repo)
  const stopHookScript = `#!/bin/bash
# Claude Code stop hook for cmux task completion detection
# This script is called when Claude Code finishes responding

LOG_FILE="/root/lifecycle/claude-hook.log"

echo "[CMUX Stop Hook] Script started at $(date)" >> "$LOG_FILE"
echo "[CMUX Stop Hook] CMUX_TASK_RUN_ID=\${CMUX_TASK_RUN_ID}" >> "$LOG_FILE"
echo "[CMUX Stop Hook] CMUX_CALLBACK_URL=\${CMUX_CALLBACK_URL}" >> "$LOG_FILE"

if [ -n "\${CMUX_TASK_RUN_JWT}" ] && [ -n "\${CMUX_TASK_RUN_ID}" ] && [ -n "\${CMUX_CALLBACK_URL}" ]; then
  (
    # Call crown/complete for status updates
    echo "[CMUX Stop Hook] Calling crown/complete..." >> "$LOG_FILE"
    curl -s -X POST "\${CMUX_CALLBACK_URL}/api/crown/complete" \\
      -H "Content-Type: application/json" \\
      -H "x-cmux-token: \${CMUX_TASK_RUN_JWT}" \\
      -d "{\\"taskRunId\\": \\"\${CMUX_TASK_RUN_ID}\\", \\"exitCode\\": 0}" \\
      >> "$LOG_FILE" 2>&1
    echo "" >> "$LOG_FILE"

    # Call notifications endpoint for user notification
    echo "[CMUX Stop Hook] Calling notifications/agent-stopped..." >> "$LOG_FILE"
    curl -s -X POST "\${CMUX_CALLBACK_URL}/api/notifications/agent-stopped" \\
      -H "Content-Type: application/json" \\
      -H "x-cmux-token: \${CMUX_TASK_RUN_JWT}" \\
      -d "{\\"taskRunId\\": \\"\${CMUX_TASK_RUN_ID}\\"}" \\
      >> "$LOG_FILE" 2>&1
    echo "" >> "$LOG_FILE"
    echo "[CMUX Stop Hook] API calls completed at $(date)" >> "$LOG_FILE"
  ) &
else
  echo "[CMUX Stop Hook] Missing required env vars, skipping API calls" >> "$LOG_FILE"
fi

# Write completion marker for backward compatibility
if [ -n "\${CMUX_TASK_RUN_ID}" ]; then
  COMPLETE_MARKER="/root/lifecycle/claude-complete-\${CMUX_TASK_RUN_ID}"
  echo "[CMUX Stop Hook] Creating completion marker at \${COMPLETE_MARKER}" >> "$LOG_FILE"
  mkdir -p "$(dirname "$COMPLETE_MARKER")"
  touch "$COMPLETE_MARKER"
fi

# Also log to stderr for visibility
echo "[CMUX Stop Hook] Task completed for task run ID: \${CMUX_TASK_RUN_ID:-unknown}" >&2

# Always allow Claude to stop (don't block)
exit 0`;

  // Add stop hook script to files array (like Codex does) to ensure it's created before git init
  files.push({
    destinationPath: `${claudeLifecycleDir}/stop-hook.sh`,
    contentBase64: Buffer.from(stopHookScript).toString("base64"),
    mode: "755",
  });

  // Check if user has provided an OAuth token (preferred) or API key
  const hasOAuthToken =
    ctx.apiKeys?.CLAUDE_CODE_OAUTH_TOKEN &&
    ctx.apiKeys.CLAUDE_CODE_OAUTH_TOKEN.trim().length > 0;
  const hasAnthropicApiKey =
    ctx.apiKeys?.ANTHROPIC_API_KEY &&
    ctx.apiKeys.ANTHROPIC_API_KEY.trim().length > 0;

  // If OAuth token is provided, write it to /etc/claude-code/env
  // The wrapper scripts (claude, npx, bunx) source this file before running claude-code
  // This is necessary because CLAUDE_CODE_OAUTH_TOKEN must be set as an env var
  // BEFORE claude-code starts (it checks OAuth early, before loading settings.json)
  if (hasOAuthToken) {
    const oauthEnvContent = `CLAUDE_CODE_OAUTH_TOKEN=${ctx.apiKeys?.CLAUDE_CODE_OAUTH_TOKEN}\n`;
    files.push({
      destinationPath: "/etc/claude-code/env",
      contentBase64: Buffer.from(oauthEnvContent).toString("base64"),
      mode: "600", // Restrictive permissions for the token
    });
  }

  // Create settings.json with hooks configuration
  // When OAuth token is present, we don't use the cmux proxy (user pays directly via their subscription)
  // When only API key is present, we route through cmux proxy for tracking/rate limiting
  const settingsConfig: Record<string, unknown> = {
    alwaysThinkingEnabled: true,
    // Always use apiKeyHelper when not using OAuth (helper outputs correct key based on user config)
    ...(hasOAuthToken ? {} : { apiKeyHelper: claudeApiKeyHelperPath }),
    hooks: {
      Stop: [
        {
          hooks: [
            {
              type: "command",
              command: `${claudeLifecycleDir}/stop-hook.sh`,
            },
          ],
        },
      ],
      Notification: [
        {
          matcher: ".*",
          hooks: [
            {
              type: "command",
              command: `${claudeLifecycleDir}/stop-hook.sh`,
            },
          ],
        },
      ],
    },
    env: {
      CLAUDE_CODE_ENABLE_TELEMETRY: 0,
      CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: 1,
      ...(hasOAuthToken
        ? {}
        : {
          ANTHROPIC_BASE_URL: `${ctx.callbackUrl}/api/anthropic`,
          ANTHROPIC_CUSTOM_HEADERS: `x-cmux-token:${ctx.taskRunJwt}\nx-cmux-source:cmux`,
        }
      ),
    },
  };

  // Add settings.json to files array as well
  files.push({
    destinationPath: "$HOME/.claude/settings.json",
    contentBase64: Buffer.from(
      JSON.stringify(settingsConfig, null, 2),
    ).toString("base64"),
    mode: "644",
  });

  // Add apiKey helper script - outputs user's API key if provided, otherwise placeholder
  const apiKeyToOutput = hasAnthropicApiKey
    ? ctx.apiKeys?.ANTHROPIC_API_KEY
    : CMUX_ANTHROPIC_PROXY_PLACEHOLDER_API_KEY;
  const helperScript = `#!/bin/sh
echo ${apiKeyToOutput}`;
  files.push({
    destinationPath: claudeApiKeyHelperPath,
    contentBase64: Buffer.from(helperScript).toString("base64"),
    mode: "700",
  });

  // Log the files for debugging
  startupCommands.push(
    `echo '[CMUX] Created Claude hook files in /root/lifecycle:' && ls -la ${claudeLifecycleDir}/`,
  );
  startupCommands.push(
    "echo '[CMUX] Settings directory in ~/.claude:' && ls -la /root/.claude/",
  );

  return {
    files,
    env,
    startupCommands,
    unsetEnv: [...CLAUDE_KEY_ENV_VARS_TO_UNSET],
  };
}
