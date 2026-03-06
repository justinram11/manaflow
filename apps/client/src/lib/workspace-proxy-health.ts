import { buildTerminalUrl } from "@/lib/terminal-url";
import { toXtermBaseUrl } from "@/lib/toProxyWorkspaceUrl";

type WorkspacePortMap = {
  pty?: string;
  vnc?: string;
  proxy?: string;
  vscode?: string;
  worker?: string;
};

export function buildWorkspaceHealthUrl(
  workspaceUrl: string,
  provider: string,
  ports?: WorkspacePortMap
): URL | null {
  const baseUrl = toXtermBaseUrl(workspaceUrl, provider, ports);
  if (!baseUrl) {
    return null;
  }

  return buildTerminalUrl(baseUrl, "/health");
}

export async function checkWorkspaceProxyHealth(
  workspaceUrl: string,
  provider: string,
  ports?: WorkspacePortMap
): Promise<boolean> {
  const healthUrl = buildWorkspaceHealthUrl(workspaceUrl, provider, ports);
  if (!healthUrl) {
    return false;
  }

  try {
    const response = await fetch(healthUrl, {
      headers: {
        Accept: "application/json",
      },
    });
    return response.ok;
  } catch (error) {
    console.error("[workspace-proxy-health] Health check failed:", error);
    return false;
  }
}
