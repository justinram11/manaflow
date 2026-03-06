import {
  LOCAL_VSCODE_PLACEHOLDER_HOST,
  isLoopbackHostname,
} from "@cmux/shared";
import { env } from "../client-env";

const MORPH_HOST_REGEX = /^port-(\d+)-morphvm-([^.]+)\.http\.cloud\.morph\.so$/;

interface MorphUrlComponents {
  url: URL;
  morphId: string;
  port: number;
}

export function normalizeWorkspaceOrigin(origin: string | null): string | null {
  if (!origin) {
    return null;
  }

  try {
    const url = new URL(origin);
    return `${url.protocol}//${url.host}`;
  } catch {
    return null;
  }
}

function getSecureBrowserOrigin(browserOrigin?: string | null): string | null {
  const normalizedPreferredOrigin = normalizeWorkspaceOrigin(browserOrigin ?? null);
  if (normalizedPreferredOrigin) {
    try {
      const url = new URL(normalizedPreferredOrigin);
      if (url.protocol === "https:") {
        return normalizedPreferredOrigin;
      }
    } catch {
      return null;
    }
  }

  if (typeof window === "undefined") {
    return null;
  }

  return window.location.protocol === "https:" ? window.location.origin : null;
}

function toWorkspaceProxyPath(hostname: string, port: string, pathname: string): string {
  const encodedHost = encodeURIComponent(hostname);
  const encodedPort = encodeURIComponent(port);
  const normalizedPath = pathname.startsWith("/") ? pathname : `/${pathname}`;
  return `/_cmux/workspaces/${encodedHost}/${encodedPort}${normalizedPath}`;
}

function createSecureWorkspaceProxyUrl(
  hostname: string,
  port: string,
  pathname: string,
  browserOrigin?: string | null
): string | null {
  const secureBrowserOrigin = getSecureBrowserOrigin(browserOrigin);
  if (!secureBrowserOrigin) {
    return null;
  }

  try {
    const proxiedUrl = new URL(secureBrowserOrigin);
    proxiedUrl.pathname = toWorkspaceProxyPath(hostname, port, pathname);
    proxiedUrl.search = "";
    proxiedUrl.hash = "";
    return proxiedUrl.toString();
  } catch {
    return null;
  }
}

function rewriteUrlForSecureWorkspaceProxy(
  url: string,
  browserOrigin?: string | null
): string {
  const secureBrowserOrigin = getSecureBrowserOrigin(browserOrigin);
  if (!secureBrowserOrigin) {
    return url;
  }

  try {
    const target = new URL(url);
    if (target.protocol !== "http:" || !target.port) {
      return url;
    }

    const proxiedUrl = new URL(secureBrowserOrigin);
    proxiedUrl.pathname = toWorkspaceProxyPath(
      target.hostname,
      target.port,
      target.pathname
    );
    proxiedUrl.search = target.search;
    proxiedUrl.hash = target.hash;
    return proxiedUrl.toString();
  } catch {
    return url;
  }
}

export function rewriteLocalWorkspaceUrlIfNeeded(
  url: string,
  preferredOrigin?: string | null
): string {
  if (!shouldRewriteUrl(url)) {
    return url;
  }

  const origin = normalizeWorkspaceOrigin(preferredOrigin ?? null);
  if (!origin) {
    return url;
  }

  try {
    const target = new URL(url);
    const originUrl = new URL(origin);
    target.protocol = originUrl.protocol;
    target.hostname = originUrl.hostname;
    target.port = originUrl.port;
    return target.toString();
  } catch {
    return url;
  }
}

function shouldRewriteUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname;
    return (
      isLoopbackHostname(hostname) ||
      hostname.toLowerCase() === LOCAL_VSCODE_PLACEHOLDER_HOST
    );
  } catch {
    return false;
  }
}

function parseMorphUrl(input: string): MorphUrlComponents | null {
  if (!input.includes("morph.so")) {
    return null;
  }

  try {
    const url = new URL(input);
    const match = url.hostname.match(MORPH_HOST_REGEX);

    if (!match) {
      return null;
    }

    const [, portString, morphId] = match;
    const port = Number.parseInt(portString, 10);

    if (Number.isNaN(port)) {
      return null;
    }

    return {
      url,
      morphId,
      port,
    };
  } catch {
    return null;
  }
}

function createMorphPortUrl(
  components: MorphUrlComponents,
  port: number
): URL {
  const url = new URL(components.url.toString());
  url.hostname = `port-${port}-morphvm-${components.morphId}.http.cloud.morph.so`;
  return url;
}

export function toProxyWorkspaceUrl(
  workspaceUrl: string,
  preferredOrigin?: string | null
): string {
  const rewrittenUrl = rewriteLocalWorkspaceUrlIfNeeded(workspaceUrl, preferredOrigin);
  return rewriteUrlForSecureWorkspaceProxy(rewrittenUrl, preferredOrigin);
}

export function toMorphVncUrl(sourceUrl: string): string | null {
  const components = parseMorphUrl(sourceUrl);

  if (!components) {
    return null;
  }

  const vncUrl = createMorphPortUrl(components, 39380);
  vncUrl.pathname = "/vnc.html";

  const searchParams = new URLSearchParams();
  searchParams.set("autoconnect", "1");
  searchParams.set("resize", "scale");
  searchParams.set("reconnect", "1");
  searchParams.set("reconnect_delay", "1000");
  vncUrl.search = `?${searchParams.toString()}`;
  vncUrl.hash = "";

  return vncUrl.toString();
}

/**
 * Convert a workspace URL to a VNC websocket URL for direct noVNC/RFB connection.
 * This returns a wss:// URL pointing to the /websockify endpoint.
 */
export function toMorphVncWebsocketUrl(sourceUrl: string): string | null {
  const components = parseMorphUrl(sourceUrl);

  if (!components) {
    return null;
  }

  const wsUrl = createMorphPortUrl(components, 39380);
  wsUrl.protocol = "wss:";
  wsUrl.pathname = "/websockify";
  wsUrl.search = "";
  wsUrl.hash = "";

  return wsUrl.toString();
}

export function toMorphXtermBaseUrl(sourceUrl: string): string | null {
  const components = parseMorphUrl(sourceUrl);

  if (!components) {
    return null;
  }

  // In web mode, use the Morph URLs directly without proxy rewriting
  if (env.NEXT_PUBLIC_WEB_MODE) {
    const morphUrl = createMorphPortUrl(components, 39383);
    morphUrl.pathname = "/";
    morphUrl.search = "";
    morphUrl.hash = "";
    return morphUrl.toString();
  }

  const scope = "base";
  const proxiedUrl = new URL(components.url.toString());
  proxiedUrl.hostname = `cmux-${components.morphId}-${scope}-39383.cmux.app`;
  proxiedUrl.port = "";
  proxiedUrl.pathname = "/";
  proxiedUrl.search = "";
  proxiedUrl.hash = "";

  return proxiedUrl.toString();
}

// --- Provider-aware URL helpers ---

interface PortMap {
  vnc?: string;
  pty?: string;
  proxy?: string;
  vscode?: string;
  worker?: string;
  iosVnc?: string;
}

/**
 * Build a VNC websocket URL for any provider.
 * Morph uses subdomain-based routing; Docker uses direct host:port.
 */
export function toVncWebsocketUrl(
  vscodeUrl: string,
  provider: string,
  ports?: PortMap,
): string | null {
  if (provider === "morph") return toMorphVncWebsocketUrl(vscodeUrl);
  if ((provider === "docker" || provider === "incus" || provider === "aws") && ports?.vnc) {
    try {
      const vscodeTarget = new URL(vscodeUrl);
      const proxiedUrl =
        ports.vnc
          ? createSecureWorkspaceProxyUrl(
              vscodeTarget.hostname,
              ports.vnc,
              "/websockify"
            )
          : null;
      if (proxiedUrl) {
        const url = new URL(proxiedUrl);
        url.protocol = "wss:";
        return url.toString();
      }

      const url = new URL(vscodeUrl);
      url.port = ports.vnc;
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      url.pathname = "/websockify";
      url.search = "";
      url.hash = "";
      return url.toString();
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Build a VNC viewer URL (vnc.html) for any provider.
 */
export function toVncUrl(
  vscodeUrl: string,
  provider: string,
  ports?: PortMap,
): string | null {
  if (provider === "morph") return toMorphVncUrl(vscodeUrl);
  if ((provider === "docker" || provider === "incus" || provider === "aws") && ports?.vnc) {
    try {
      const vscodeTarget = new URL(vscodeUrl);
      const proxiedUrl =
        vscodeTarget.port
          ? createSecureWorkspaceProxyUrl(
              vscodeTarget.hostname,
              vscodeTarget.port,
              "/vnc/vnc.html"
            )
          : null;
      if (proxiedUrl) {
        const url = new URL(proxiedUrl);
        const searchParams = new URLSearchParams();
        searchParams.set("autoconnect", "1");
        searchParams.set("resize", "scale");
        searchParams.set("reconnect", "1");
        searchParams.set("reconnect_delay", "1000");
        url.search = `?${searchParams.toString()}`;
        return url.toString();
      }

      const url = new URL(vscodeUrl);
      url.protocol = url.protocol === "wss:" ? "https:" : "http:";
      url.port = ports.vnc;
      url.pathname = "/vnc.html";
      const searchParams = new URLSearchParams();
      searchParams.set("autoconnect", "1");
      searchParams.set("resize", "scale");
      searchParams.set("reconnect", "1");
      searchParams.set("reconnect_delay", "1000");
      url.search = `?${searchParams.toString()}`;
      url.hash = "";
      return url.toString();
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Build an xterm/PTY base URL for any provider.
 */
export function toXtermBaseUrl(
  vscodeUrl: string,
  provider: string,
  ports?: PortMap,
): string | null {
  if (provider === "morph") return toMorphXtermBaseUrl(vscodeUrl);
  if ((provider === "docker" || provider === "incus" || provider === "aws") && ports?.pty) {
    try {
      const secureBrowserOrigin = getSecureBrowserOrigin();
      if (secureBrowserOrigin) {
        const vscodeTarget = new URL(vscodeUrl);
        const proxiedUrl = new URL(secureBrowserOrigin);
        proxiedUrl.pathname = toWorkspaceProxyPath(
          vscodeTarget.hostname,
          ports.pty,
          "/"
        );
        proxiedUrl.search = "";
        proxiedUrl.hash = "";
        return proxiedUrl.toString();
      }

      const url = new URL(vscodeUrl);
      url.port = ports.pty;
      url.pathname = "/";
      url.search = "";
      url.hash = "";
      return url.toString();
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Build an iOS simulator VNC websocket URL for noVNC connection.
 * Uses the iosVnc port from the port map.
 */
export function toIosVncWebsocketUrl(
  vscodeUrl: string,
  provider: string,
  ports?: PortMap,
): string | null {
  if ((provider === "docker" || provider === "incus" || provider === "aws") && ports?.iosVnc) {
    try {
      const vscodeTarget = new URL(vscodeUrl);
      const proxiedUrl = createSecureWorkspaceProxyUrl(
        vscodeTarget.hostname,
        ports.iosVnc,
        "/websockify"
      );
      if (proxiedUrl) {
        const url = new URL(proxiedUrl);
        url.protocol = "wss:";
        return url.toString();
      }

      const url = new URL(vscodeUrl);
      url.port = ports.iosVnc;
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      url.pathname = "/websockify";
      url.search = "";
      url.hash = "";
      return url.toString();
    } catch {
      return null;
    }
  }
  return null;
}
