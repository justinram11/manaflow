import type { SandboxInstance } from "./sandbox-instance";

/**
 * Inject Claude credentials JSON (~/.claude/.credentials.json) into a sandbox
 * instance. This allows MCP OAuth tokens (e.g. Figma) to work inside containers
 * where the browser-based OAuth callback flow can't complete.
 *
 * Follows the same pattern as `injectHostSshKeys`.
 */
export async function injectClaudeCredentials(
  instance: SandboxInstance,
  credentialsJson: string,
): Promise<void> {
  await instance.exec("mkdir -p /root/.claude && chmod 700 /root/.claude");

  // Strip claudeAiOauth from the credentials JSON before injecting.
  // The CLAUDE_CREDENTIALS_JSON setting is intended for MCP OAuth tokens
  // (e.g. Figma), but users may have saved their full ~/.claude/.credentials.json
  // which includes claudeAiOauth. If injected, this stale/mismatched token
  // takes priority over CLAUDE_CODE_OAUTH_TOKEN env var and causes Claude Code
  // to show a login prompt instead of using the configured auth.
  let sanitized = credentialsJson;
  try {
    const parsed = JSON.parse(credentialsJson);
    if (parsed.claudeAiOauth) {
      delete parsed.claudeAiOauth;
      sanitized = JSON.stringify(parsed);
      console.log(
        `[claude-credentials] Stripped claudeAiOauth from .credentials.json to avoid auth conflict`,
      );
    }
  } catch {
    // If it's not valid JSON, write it as-is
  }

  const b64 = Buffer.from(sanitized).toString("base64");
  const res = await instance.exec(
    `echo '${b64}' | base64 -d > /root/.claude/.credentials.json && chmod 600 /root/.claude/.credentials.json`,
  );
  if (res.exit_code !== 0) {
    console.error(
      `[claude-credentials] Failed to write .credentials.json: ${res.stderr}`,
    );
  } else {
    console.log(
      `[claude-credentials] Injected .credentials.json into sandbox`,
    );
  }
}

/**
 * Strip the `claudeAiOauth` block from an existing
 * `/root/.claude/.credentials.json` inside a sandbox.
 *
 * Claude Code reads `~/.claude/.credentials.json` and its `claudeAiOauth`
 * token takes priority over the `CLAUDE_CODE_OAUTH_TOKEN` env var. When a
 * stale token gets baked into an environment snapshot (e.g. from running
 * `claude` during env setup), it shadows the per-run token cmux injects and
 * Claude Code falls back to a login prompt. Removing the block makes the
 * injected env var authoritative. Other keys (MCP OAuth tokens) are kept;
 * the file is deleted if `claudeAiOauth` was its only content.
 */
export async function stripClaudeAiOauthFromCredentialsFile(
  instance: SandboxInstance,
): Promise<void> {
  const script = `python3 -c "
import json, os
p = '/root/.claude/.credentials.json'
try:
    d = json.load(open(p))
except Exception:
    raise SystemExit(0)
if isinstance(d, dict) and 'claudeAiOauth' in d:
    del d['claudeAiOauth']
    if d:
        json.dump(d, open(p, 'w'))
    else:
        os.remove(p)
    print('stripped')
" 2>/dev/null`;
  const res = await instance.exec(script);
  if (res.exit_code !== 0) {
    console.error(
      `[claude-credentials] Failed to strip claudeAiOauth from .credentials.json: ${res.stderr}`,
    );
  } else if (res.stdout.includes("stripped")) {
    console.log(
      `[claude-credentials] Stripped stale claudeAiOauth from sandbox .credentials.json`,
    );
  }
}

/**
 * Inject Claude auth (OAuth token or API key) into the sandbox so that
 * `claude` works from any terminal, not just agent-spawned sessions.
 *
 * Writes to multiple locations to ensure the env var is available regardless
 * of shell type (login vs non-login, bash vs zsh):
 * - /etc/claude-code/env (sourced by claude wrapper scripts if present)
 * - /etc/profile.d/ (sourced by login bash shells)
 * - ~/.bashrc (sourced by interactive non-login bash)
 * - ~/.zshrc (sourced by interactive zsh)
 *
 * Priority: OAuth token > Anthropic API key.
 */
export async function injectClaudeAuth(
  instance: SandboxInstance,
  apiKeys: Record<string, string>,
): Promise<void> {
  const oauthToken = apiKeys.CLAUDE_CODE_OAUTH_TOKEN?.trim();
  const anthropicKey = apiKeys.ANTHROPIC_API_KEY?.trim();

  if (!oauthToken && !anthropicKey) {
    return;
  }

  // Build env content lines
  const envLines: string[] = [];
  if (oauthToken) {
    envLines.push(`CLAUDE_CODE_OAUTH_TOKEN=${oauthToken}`);
  } else if (anthropicKey) {
    envLines.push(`ANTHROPIC_API_KEY=${anthropicKey}`);
  }

  const envContent = envLines.join("\n") + "\n";
  const b64 = Buffer.from(envContent).toString("base64");

  // Write to /etc/claude-code/env (used by wrapper scripts if present)
  const envRes = await instance.exec(
    `mkdir -p /etc/claude-code && echo '${b64}' | base64 -d > /etc/claude-code/env && chmod 644 /etc/claude-code/env`,
  );
  if (envRes.exit_code !== 0) {
    console.error(
      `[claude-credentials] Failed to write /etc/claude-code/env: ${envRes.stderr}`,
    );
  }

  // Write to /etc/profile.d/ for login bash shells
  const exportLines = envLines.map((l) => `export ${l}`).join("\n") + "\n";
  const profileB64 = Buffer.from(exportLines).toString("base64");
  await instance.exec(
    `echo '${profileB64}' | base64 -d > /etc/profile.d/cmux-claude-auth.sh && chmod 644 /etc/profile.d/cmux-claude-auth.sh`,
  );

  // Append to ~/.bashrc and ~/.zshrc for non-login / interactive shells.
  // Use a marker comment so we don't duplicate on repeated calls.
  const marker = "# cmux-claude-auth";
  const rcSnippet = `\n${marker}\n${exportLines}`;
  const rcB64 = Buffer.from(rcSnippet).toString("base64");

  // Ensure ~/.claude.json has hasCompletedOnboarding so Claude Code
  // skips the interactive login/setup flow and uses the token directly.
  const onboardingScript = `python3 -c "
import json, os
p = os.path.expanduser('~/.claude.json')
try:
    d = json.load(open(p))
except Exception:
    d = {}
d['hasCompletedOnboarding'] = True
d['hasAcknowledgedCostThreshold'] = True
json.dump(d, open(p, 'w'))
" 2>/dev/null`;

  await Promise.all([
    instance.exec(
      `grep -q '${marker}' /root/.bashrc 2>/dev/null || echo '${rcB64}' | base64 -d >> /root/.bashrc`,
    ),
    instance.exec(
      `grep -q '${marker}' /root/.zshrc 2>/dev/null || echo '${rcB64}' | base64 -d >> /root/.zshrc`,
    ),
    instance.exec(onboardingScript),
    // Remove any stale claudeAiOauth (e.g. baked into an environment
    // snapshot) so the token we just injected via env var is authoritative.
    stripClaudeAiOauthFromCredentialsFile(instance),
  ]);

  console.log(
    `[claude-credentials] Injected Claude auth into sandbox (${oauthToken ? "OAuth" : "API key"})`,
  );
}
