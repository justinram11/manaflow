function withTrailingSlash(input: string): string {
  return input.endsWith("/") ? input : `${input}/`;
}

export function buildTerminalUrl(baseUrl: string, pathname: string): URL {
  const normalizedBaseUrl = withTrailingSlash(baseUrl);
  const normalizedPath = pathname.replace(/^\/+/, "");
  return new URL(normalizedPath, normalizedBaseUrl);
}

export function buildTerminalWebSocketUrl(
  baseUrl: string,
  terminalId: string
): URL {
  const url = buildTerminalUrl(
    baseUrl,
    `sessions/${encodeURIComponent(terminalId)}/ws`
  );
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url;
}
