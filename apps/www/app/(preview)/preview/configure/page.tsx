import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { PreviewConfigureClient } from "@/components/preview/preview-configure-client";
import { stackServerApp } from "@/lib/utils/stack";
import {
  getTeamDisplayName,
  getTeamId,
  getTeamSlug,
  getTeamSlugOrId,
  type StackTeam,
} from "@/lib/team-utils";
import { env } from "@/lib/utils/www-env";
import { typedZid } from "@cmux/shared/utils/typed-zid";
import { getDb } from "@cmux/db";
import { listProviderConnections } from "@cmux/db/queries/repos";
import { createInstallState } from "@cmux/db/mutations/repos";

type PageProps = {
  searchParams?: Promise<SearchParams>;
};

type SearchParams = Record<string, string | string[] | undefined>;

function buildConfigurePath(search: SearchParams | undefined): string {
  const params = new URLSearchParams();
  if (search) {
    Object.entries(search).forEach(([key, value]) => {
      if (Array.isArray(value)) {
        value.forEach((entry) => {
          if (entry) params.append(key, entry);
        });
      } else if (value) {
        params.set(key, value);
      }
    });
  }
  const query = params.toString();
  return query ? `/preview/configure?${query}` : "/preview/configure";
}

function getSearchValue(
  search: SearchParams | undefined,
  key: string
): string | null {
  if (!search) {
    return null;
  }
  const value = search[key];
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

export default async function PreviewConfigurePage({ searchParams }: PageProps) {
  const resolvedSearch = await searchParams;
  const configurePath = buildConfigurePath(resolvedSearch);

  const user = await stackServerApp.getUser();

  // If user is not authenticated, redirect to sign-in
  if (!user) {
    const signInUrl = `/handler/sign-in?after_auth_return_to=${encodeURIComponent(configurePath)}`;
    return redirect(signInUrl);
  }

  // Try to get auth tokens and user data
  // Wrap in try-catch to handle any Stack Auth API errors gracefully
  let accessToken: string | null = null;
  let teams: StackTeam[] = [];

  try {
    const [auth, teamsResult] = await Promise.all([
      user.getAuthJson(),
      user.listTeams(),
    ]);
    teams = teamsResult;
    accessToken = auth.accessToken;
  } catch (error) {
    console.error("[PreviewConfigurePage] Failed to fetch user data from Stack Auth", error);
    // Fall through to try creating a fresh session
  }

  // If accessToken is null, try creating a fresh session to get valid tokens
  // This can happen right after OAuth sign-in when tokens aren't fully propagated
  if (!accessToken) {
    console.log("[PreviewConfigurePage] accessToken is null, attempting to create fresh session");
    try {
      const freshSession = await user.createSession({ expiresInMillis: 24 * 60 * 60 * 1000 });
      const freshTokens = await freshSession.getTokens();
      if (freshTokens.accessToken) {
        accessToken = freshTokens.accessToken;
        console.log("[PreviewConfigurePage] Got fresh access token from new session");
        // Also try to fetch teams if we didn't get them earlier
        if (teams.length === 0) {
          try {
            teams = await user.listTeams();
          } catch (teamsError) {
            console.error("[PreviewConfigurePage] Failed to fetch teams", teamsError);
          }
        }
      }
    } catch (error) {
      console.error("[PreviewConfigurePage] Failed to create fresh session", error);
    }
  }

  // If we still don't have an access token, redirect to sign-in
  if (!accessToken) {
    console.error("[PreviewConfigurePage] No access token available after retry, redirecting to sign-in");
    const signInUrl = `/handler/sign-in?after_auth_return_to=${encodeURIComponent(configurePath)}`;
    return redirect(signInUrl);
  }

  if (teams.length === 0) {
    notFound();
  }

  const repo = getSearchValue(resolvedSearch, "repo");
  const installationId = getSearchValue(resolvedSearch, "installationId");
  const environmentId = getSearchValue(resolvedSearch, "environmentId");

  if (!repo) {
    notFound();
  }

  const searchTeam = getSearchValue(resolvedSearch, "team");

  const selectedTeam =
    teams.find(
      (team) =>
        Boolean(searchTeam) &&
        getTeamDisplayName(team).toLowerCase() === searchTeam?.toLowerCase()
    ) ||
    teams.find((team) => getTeamSlugOrId(team) === searchTeam) ||
    teams[0];
  const selectedTeamSlugOrId = getTeamSlugOrId(selectedTeam);

  const db = getDb();
  const connections = listProviderConnections(db, selectedTeamSlugOrId);

  const hasGithubAppInstallation = connections.some(
    (connection) => connection.isActive,
  );

  if (!hasGithubAppInstallation) {
    const githubAppSlug = process.env.NEXT_PUBLIC_GITHUB_APP_SLUG;
    if (!githubAppSlug) {
      throw new Error("GitHub App slug is not configured");
    }

    const headerList = await headers();
    const host = headerList.get("x-forwarded-host") ?? headerList.get("host");
    const protocol = headerList.get("x-forwarded-proto") ?? "https";
    const returnUrl =
      host && configurePath.startsWith("/")
        ? `${protocol}://${host}${configurePath}`
        : configurePath;

    const installStateSecret = env.INSTALL_STATE_SECRET;
    if (!installStateSecret) {
      throw new Error("INSTALL_STATE_SECRET is not configured");
    }

    const { teamId, nonce, iat, exp } = createInstallState(db, {
      teamSlugOrId: selectedTeamSlugOrId,
      userId: user.id,
      returnUrl,
    });

    // Sign the install state token
    const payloadObj = {
      ver: 1,
      teamId,
      userId: user.id,
      iat,
      exp,
      nonce,
      returnUrl,
    };
    const payload = JSON.stringify(payloadObj);
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(installStateSecret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const sigBuf = new Uint8Array(
      await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload)),
    );
    const toBase64Url = (buf: Uint8Array) => {
      let binary = "";
      for (const b of buf) binary += String.fromCharCode(b);
      return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    };
    const payloadB64 = toBase64Url(new TextEncoder().encode(payload));
    const sigB64 = toBase64Url(sigBuf);
    const state = `v2.${payloadB64}.${sigB64}`;

    const url = new URL(`https://github.com/apps/${githubAppSlug}/installations/new`);
    url.searchParams.set("state", state);
    return redirect(url.toString());
  }

  const clientTeams = teams.map((team) => ({
    id: getTeamId(team),
    slug: getTeamSlug(team),
    slugOrId: getTeamSlugOrId(team),
    displayName: getTeamDisplayName(team),
    name: team.name ?? getTeamDisplayName(team),
  }));

  let initialEnvVarsContent: string | null = null;
  // Scripts will be detected client-side in background, start with null
  let initialMaintenanceScript: string | null = null;
  let initialDevScript: string | null = null;

  if (environmentId) {
    try {
      // Validate and parse environment ID
      const parsedEnvId = typedZid("environments").parse(environmentId);

      // Fetch environment details directly from DB
      const { getEnvironmentByTeam } = await import("@cmux/db/queries/environments");
      const envDb = getDb();
      const environment = getEnvironmentByTeam(envDb, selectedTeamSlugOrId, parsedEnvId);

      if (environment) {
        initialMaintenanceScript = environment.maintenanceScript ?? null;
        initialDevScript = environment.devScript ?? null;

        // Fetch environment variables directly from Stack Data Vault
        try {
          const store = await stackServerApp.getDataVaultStore("cmux-snapshot-envs");
          const varsContent = await store.getValue(environment.dataVaultKey, {
            secret: env.STACK_DATA_VAULT_SECRET ?? "",
          });
          if (typeof varsContent === "string") {
            initialEnvVarsContent = varsContent;
          }
        } catch (error) {
          console.error("Failed to fetch environment vars from data vault", error);
        }
      }
    } catch (error) {
      console.error("Failed to fetch environment details", error);
    }
  }

  return (
    <PreviewConfigureClient
      initialTeamSlugOrId={selectedTeamSlugOrId}
      teams={clientTeams}
      repo={repo}
      installationId={installationId}
      initialEnvVarsContent={initialEnvVarsContent}
      initialMaintenanceScript={initialMaintenanceScript}
      initialDevScript={initialDevScript}
      startAtConfigureEnvironment={Boolean(environmentId)}
    />
  );
}
