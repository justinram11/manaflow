import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type { RequestCookie } from "next/dist/compiled/@edge-runtime/cookies";

import { env } from "@/lib/utils/www-env";
import { OpenCmuxClient } from "./OpenCmuxClient";
import { CheckSessionStorageRedirect } from "./CheckSessionStorageRedirect";

export const dynamic = "force-dynamic";

/**
 * Find a Stack Auth cookie by checking multiple naming patterns.
 * Stack Auth uses different cookie naming conventions:
 * - Local HTTP: `stack-refresh-{projectId}` / `stack-access`
 * - Production HTTPS: `__Host-stack-refresh-{projectId}` / `__Host-stack-access`
 * - With branch: `__Host-stack-refresh-{projectId}--default` / `__Host-stack-access--default`
 */
function findStackCookie(
  cookieStore: { getAll: () => RequestCookie[] },
  baseName: string
): string | undefined {
  const allCookies = cookieStore.getAll();

  // Priority order: most specific first
  // 1. __Host- prefixed with branch suffix (--default, --main, etc.)
  // 2. __Host- prefixed without suffix
  // 3. Plain name with branch suffix
  // 4. Plain name

  // First, try to find __Host- prefixed cookies (production HTTPS)
  const hostPrefixedWithBranch = allCookies.find(
    (c) => c.name.startsWith(`__Host-${baseName}--`) && c.value
  );
  if (hostPrefixedWithBranch) {
    return hostPrefixedWithBranch.value;
  }

  const hostPrefixed = allCookies.find(
    (c) => c.name === `__Host-${baseName}` && c.value
  );
  if (hostPrefixed) {
    return hostPrefixed.value;
  }

  // Then try plain name with branch suffix
  const plainWithBranch = allCookies.find(
    (c) => c.name.startsWith(`${baseName}--`) && c.value
  );
  if (plainWithBranch) {
    return plainWithBranch.value;
  }

  // Finally, try plain name
  const plain = allCookies.find((c) => c.name === baseName && c.value);
  if (plain) {
    return plain.value;
  }

  return undefined;
}

type AfterSignInPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

const CMUX_SCHEME = "cmux://";

function getSingleValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }
  if (typeof value === "string") {
    return value;
  }
  return null;
}

function isRelativePath(target: string): boolean {
  if (!target) {
    return false;
  }
  if (target.startsWith("//")) {
    return false;
  }
  return target.startsWith("/");
}

/**
 * Check if a URL is safe to redirect to.
 * Only allows relative paths (starting with /).
 * Returns the path if safe, null otherwise.
 */
function getSafeRedirectPath(target: string): string | null {
  if (!target) {
    return null;
  }

  // Only allow relative paths for security
  if (isRelativePath(target)) {
    return target;
  }

  // Reject absolute URLs
  return null;
}

function buildCmuxHref(baseHref: string | null, stackRefreshToken: string | undefined, stackAccessToken: string | undefined): string | null {
  if (!stackRefreshToken || !stackAccessToken) {
    return baseHref;
  }

  const pairedHref = baseHref ?? `${CMUX_SCHEME}auth-callback`;

  try {
    const url = new URL(pairedHref);
    url.searchParams.set("stack_refresh", stackRefreshToken);
    url.searchParams.set("stack_access", stackAccessToken);
    return url.toString();
  } catch {
    return `${CMUX_SCHEME}auth-callback?stack_refresh=${encodeURIComponent(stackRefreshToken)}&stack_access=${encodeURIComponent(stackAccessToken)}`;
  }
}

export default async function AfterSignInPage({ searchParams: searchParamsPromise }: AfterSignInPageProps) {
  const stackCookies = await cookies();

  // Find Stack Auth cookies using flexible matching for different environments
  // Stack Auth uses different naming conventions:
  // - Local: stack-refresh-{projectId}, stack-access
  // - Production HTTPS: __Host-stack-refresh-{projectId}--default, __Host-stack-access--default
  const refreshCookieBaseName = `stack-refresh-${env.NEXT_PUBLIC_STACK_PROJECT_ID}`;
  const stackRefreshToken = findStackCookie(stackCookies, refreshCookieBaseName);
  const stackAccessToken = findStackCookie(stackCookies, "stack-access");

  // Debug logging for production troubleshooting
  if (!stackRefreshToken || !stackAccessToken) {
    const allCookieNames = stackCookies.getAll().map((c) => c.name);
    console.log("[After Sign In] Cookie search debug:", {
      refreshCookieBaseName,
      allCookieNames,
      foundRefresh: !!stackRefreshToken,
      foundAccess: !!stackAccessToken,
    });
  }

  const searchParams = await searchParamsPromise;
  const afterAuthReturnToRaw = getSingleValue(searchParams?.after_auth_return_to ?? undefined);

  console.log("[After Sign In] Processing redirect:", {
    afterAuthReturnTo: afterAuthReturnToRaw,
    hasRefreshToken: !!stackRefreshToken,
    hasAccessToken: !!stackAccessToken,
  });

  // If no return URL in query params, check sessionStorage first (for OAuth popup flow),
  // then fall back to Electron deep link (default for desktop users)
  if (!afterAuthReturnToRaw) {
    // Return a client component that checks sessionStorage, with electron deeplink as fallback
    const electronFallbackHref = buildCmuxHref(null, stackRefreshToken, stackAccessToken);
    return <CheckSessionStorageRedirect fallbackPath="/" electronFallbackHref={electronFallbackHref} />;
  }

  // Handle Electron deep link redirects
  if (afterAuthReturnToRaw?.startsWith(CMUX_SCHEME)) {
    console.log("[After Sign In] Opening Electron app with deep link");
    const cmuxHref = buildCmuxHref(afterAuthReturnToRaw, stackRefreshToken, stackAccessToken);
    if (cmuxHref) {
      return <OpenCmuxClient href={cmuxHref} />;
    }
  }

  // Handle web redirects (relative paths only)
  if (afterAuthReturnToRaw) {
    const safePath = getSafeRedirectPath(afterAuthReturnToRaw);
    if (safePath) {
      console.log("[After Sign In] Redirecting to web path:", safePath);
      redirect(safePath);
    } else {
      console.warn("[After Sign In] Unsafe redirect URL blocked:", afterAuthReturnToRaw);
    }
  }

  // Fallback: try to open Electron app
  console.log("[After Sign In] No return path, using fallback");
  const fallbackHref = buildCmuxHref(null, stackRefreshToken, stackAccessToken);
  if (fallbackHref) {
    return <OpenCmuxClient href={fallbackHref} />;
  }

  // Final fallback: redirect to home
  redirect("/");
}
