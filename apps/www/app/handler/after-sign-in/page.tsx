import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { env } from "@/lib/utils/www-env";
import { OpenCmuxClient } from "./OpenCmuxClient";

export const dynamic = "force-dynamic";

type AfterSignInPageProps = {
  searchParams?: Record<string, string | string[] | undefined>;
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

export default async function AfterSignInPage({ searchParams }: AfterSignInPageProps) {
  const stackCookies = await cookies();
  const stackRefreshToken = stackCookies.get(`stack-refresh-${env.NEXT_PUBLIC_STACK_PROJECT_ID}`)?.value;
  const stackAccessToken = stackCookies.get("stack-access")?.value;

  const afterAuthReturnToRaw = getSingleValue(searchParams?.after_auth_return_to ?? undefined);

  if (afterAuthReturnToRaw?.startsWith(CMUX_SCHEME)) {
    const cmuxHref = buildCmuxHref(afterAuthReturnToRaw, stackRefreshToken, stackAccessToken);
    if (cmuxHref) {
      return <OpenCmuxClient href={cmuxHref} />;
    }
  } else if (afterAuthReturnToRaw && isRelativePath(afterAuthReturnToRaw)) {
    redirect(afterAuthReturnToRaw || "/");
  }

  const fallbackHref = buildCmuxHref(null, stackRefreshToken, stackAccessToken);
  if (fallbackHref) {
    return <OpenCmuxClient href={fallbackHref} />;
  }

  redirect("/");
}
