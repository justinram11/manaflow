import { normalizeOrigin } from "@cmux/shared";
import { env } from "@/client-env";

function getConfiguredWwwOrigin(): string {
  return normalizeOrigin(
    // TODO: handle main to never use this
    // process.env.NEXT_PUBLIC_RELATED_WWW_ORIGIN_PREVIEW ||
    env.NEXT_PUBLIC_WWW_ORIGIN
  );
}

function getCurrentBrowserOrigin(): string | null {
  if (typeof window === "undefined") {
    return null;
  }

  return window.location.origin;
}

function shouldPreferCurrentOrigin(
  configuredOrigin: string,
  currentOrigin: string | null
): boolean {
  if (!currentOrigin) {
    return false;
  }

  try {
    const configuredUrl = new URL(configuredOrigin);
    const currentUrl = new URL(currentOrigin);
    return (
      currentUrl.protocol === "https:" &&
      configuredUrl.protocol === "http:"
    );
  } catch {
    return false;
  }
}

export const WWW_ORIGIN = (() => {
  const configuredOrigin = getConfiguredWwwOrigin();
  const currentOrigin = getCurrentBrowserOrigin();

  if (shouldPreferCurrentOrigin(configuredOrigin, currentOrigin)) {
    return currentOrigin!;
  }

  return configuredOrigin;
})();
