import {
  LOCAL_VSCODE_PLACEHOLDER_HOST,
  isLoopbackHostname,
} from "@cmux/shared";

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
  const normalizedUrl = rewriteLocalWorkspaceUrlIfNeeded(
    workspaceUrl,
    preferredOrigin
  );
  const components = parseMorphUrl(normalizedUrl);

  if (!components) {
    return normalizedUrl;
  }

  const scope = "base"; // Default scope
  const proxiedUrl = new URL(components.url.toString());
  proxiedUrl.hostname = `cmux-${components.morphId}-${scope}-${components.port}.cmux.app`;
  return proxiedUrl.toString();
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
  vncUrl.search = `?${searchParams.toString()}`;
  vncUrl.hash = "";

  return vncUrl.toString();
}

export function toMorphXtermBaseUrl(sourceUrl: string): string | null {
  const components = parseMorphUrl(sourceUrl);

  if (!components) {
    return null;
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
