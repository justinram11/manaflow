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

  const b64 = Buffer.from(credentialsJson).toString("base64");
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

  await Promise.all([
    instance.exec(
      `grep -q '${marker}' /root/.bashrc 2>/dev/null || echo '${rcB64}' | base64 -d >> /root/.bashrc`,
    ),
    instance.exec(
      `grep -q '${marker}' /root/.zshrc 2>/dev/null || echo '${rcB64}' | base64 -d >> /root/.zshrc`,
    ),
  ]);

  console.log(
    `[claude-credentials] Injected Claude auth into sandbox (${oauthToken ? "OAuth" : "API key"})`,
  );
}
