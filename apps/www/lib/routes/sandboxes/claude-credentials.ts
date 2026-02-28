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
