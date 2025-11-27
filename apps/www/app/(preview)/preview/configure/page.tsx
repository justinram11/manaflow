import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { PreviewConfigureClient, type FrameworkPreset } from "@/components/preview/preview-configure-client";
import { getConvex } from "@/lib/utils/get-convex";
import { stackServerApp } from "@/lib/utils/stack";
import { createGitHubClient } from "@/lib/github/octokit";
import { api } from "@cmux/convex/api";

export const dynamic = "force-dynamic";

type PageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

type StackTeam = Awaited<ReturnType<typeof stackServerApp.listTeams>>[number];

function buildConfigurePath(search: Record<string, string | string[] | undefined> | undefined): string {
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

function getTeamSlugOrId(team: StackTeam): string {
  const candidate = team as unknown as {
    slug?: string | null;
    teamId?: string;
    id?: string;
  };
  return candidate.slug ?? candidate.teamId ?? candidate.id ?? "";
}

function getTeamId(team: StackTeam): string {
  const candidate = team as unknown as {
    teamId?: string;
    id?: string;
  };
  return candidate.teamId ?? candidate.id ?? getTeamSlugOrId(team);
}

function getTeamSlug(team: StackTeam): string | null {
  const candidate = team as unknown as { slug?: string | null };
  return candidate.slug ?? null;
}

function getTeamDisplayName(team: StackTeam): string {
  const candidate = team as unknown as {
    displayName?: string | null;
    name?: string | null;
  };
  return candidate.displayName ?? candidate.name ?? getTeamSlugOrId(team);
}

type PackageJson = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
};

function chooseFrameworkFromPackageJson(pkg: PackageJson): FrameworkPreset | null {
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  const hasAny = (...keys: string[]) => keys.some((key) => deps[key]);

  if (hasAny("next")) return "next";
  if (hasAny("nuxt")) return "nuxt";
  if (hasAny("@remix-run/node", "@remix-run/serve", "remix")) return "remix";
  if (hasAny("astro")) return "astro";
  if (hasAny("@sveltejs/kit")) return "sveltekit";
  if (hasAny("@angular/core")) return "angular";
  if (hasAny("react-scripts")) return "cra";
  if (hasAny("vue", "@vue/cli-service")) return "vue";
  if (hasAny("vite")) return "vite";

  const scripts = pkg.scripts ?? {};
  const scriptValues = Object.values(scripts);
  if (scriptValues.some((val) => val.includes("next"))) return "next";
  if (scriptValues.some((val) => val.includes("nuxt"))) return "nuxt";
  if (scriptValues.some((val) => val.includes("remix"))) return "remix";
  if (scriptValues.some((val) => val.includes("astro"))) return "astro";
  if (scriptValues.some((val) => val.includes("svelte"))) return "sveltekit";
  if (scriptValues.some((val) => val.includes("ng "))) return "angular";
  if (scriptValues.some((val) => val.includes("vue"))) return "vue";
  if (scriptValues.some((val) => val.includes("vite"))) return "vite";
  return null;
}

async function fetchRepoJson(owner: string, name: string, path: string): Promise<PackageJson | null> {
  const octokit = createGitHubClient(undefined, { useTokenRotation: true });
  try {
    const res = await octokit.request("GET /repos/{owner}/{repo}/contents/{path}", {
      owner,
      repo: name,
      path,
    });
    const data = res.data as { content?: string };
    if (!("content" in data) || !data.content) {
      return null;
    }
    const raw = Buffer.from(data.content, "base64").toString("utf-8");
    return JSON.parse(raw) as PackageJson;
  } catch (error) {
    console.error("Failed to read repo json", { owner, name, path, error });
    return null;
  }
}

async function repoHasFile(owner: string, name: string, path: string): Promise<boolean> {
  const octokit = createGitHubClient(undefined, { useTokenRotation: true });
  try {
    await octokit.request("GET /repos/{owner}/{repo}/contents/{path}", {
      owner,
      repo: name,
      path,
    });
    return true;
  } catch {
    return false;
  }
}

async function detectFrameworkPreset(repoFullName: string): Promise<FrameworkPreset> {
  const [owner, name] = repoFullName.split("/");
  if (!owner || !name) {
    return "other";
  }

  const pkg = await fetchRepoJson(owner, name, "package.json");
  const pkgGuess = pkg ? chooseFrameworkFromPackageJson(pkg) : null;
  if (pkgGuess) {
    return pkgGuess;
  }

  const fileGuesses: Array<[FrameworkPreset, string[]]> = [
    ["next", ["next.config.js", "next.config.ts", "next.config.mjs"]],
    ["nuxt", ["nuxt.config.ts", "nuxt.config.js", "nuxt.config.mjs"]],
    ["remix", ["remix.config.js", "remix.config.ts"]],
    ["astro", ["astro.config.mjs", "astro.config.ts", "astro.config.js"]],
    ["sveltekit", ["svelte.config.js", "svelte.config.ts"]],
    ["angular", ["angular.json"]],
    ["vite", ["vite.config.ts", "vite.config.js", "vite.config.mjs"]],
    ["vue", ["vue.config.js", "vue.config.ts"]],
  ];

  for (const [preset, paths] of fileGuesses) {
    // eslint-disable-next-line no-await-in-loop
    const found = await paths.reduce<Promise<boolean>>(async (accPromise, candidate) => {
      const acc = await accPromise;
      if (acc) return true;
      return repoHasFile(owner, name, candidate);
    }, Promise.resolve(false));
    if (found) {
      return preset;
    }
  }

  return "other";
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

  const [{ accessToken }, teams] = await Promise.all([
    user.getAuthJson(),
    user.listTeams(),
  ]);

  if (teams.length === 0) {
    notFound();
  }

  if (!accessToken) {
    throw new Error("Missing Stack access token");
  }

  const repo = (() => {
    if (!resolvedSearch) {
      return null;
    }
    const value = resolvedSearch.repo;
    if (Array.isArray(value)) {
      return value[0] ?? null;
    }
    return value ?? null;
  })();

  const installationId = (() => {
    if (!resolvedSearch) {
      return null;
    }
    const value = resolvedSearch.installationId;
    if (Array.isArray(value)) {
      return value[0] ?? null;
    }
    return value ?? null;
  })();

  const environmentId = (() => {
    if (!resolvedSearch) {
      return null;
    }
    const value = resolvedSearch.environmentId;
    if (Array.isArray(value)) {
      return value[0] ?? null;
    }
    return value ?? null;
  })();

  if (!repo) {
    notFound();
  }

  const searchTeam = (() => {
    if (!resolvedSearch) {
      return null;
    }
    const value = resolvedSearch.team;
    if (Array.isArray(value)) {
      return value[0] ?? null;
    }
    return value ?? null;
  })();

  const selectedTeam =
    teams.find(
      (team) =>
        Boolean(searchTeam) &&
        getTeamDisplayName(team).toLowerCase() === searchTeam?.toLowerCase()
    ) ||
    teams.find((team) => getTeamSlugOrId(team) === searchTeam) ||
    teams[0];
  const selectedTeamSlugOrId = getTeamSlugOrId(selectedTeam);

  const convex = getConvex({ accessToken });
  const providerConnections = await convex.query(api.github.listProviderConnections, {
    teamSlugOrId: selectedTeamSlugOrId,
  });

  const hasGithubAppInstallation = providerConnections.some(
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

    const { state } = await convex.mutation(api.github_app.mintInstallState, {
      teamSlugOrId: selectedTeamSlugOrId,
      returnUrl,
    });

    const url = new URL(`https://github.com/apps/${githubAppSlug}/installations/new`);
    url.searchParams.set("state", state);
    return redirect(url.toString());
  }

  const clientTeams = teams.map((team) => ({
    id: getTeamId(team),
    slug: getTeamSlug(team),
    slugOrId: getTeamSlugOrId(team),
    displayName: getTeamDisplayName(team),
    name:
      (team as unknown as { name?: string | null }).name ??
      getTeamDisplayName(team),
  }));

  const detectedFrameworkPreset = await detectFrameworkPreset(repo);

  const headerList = await headers();
  const host = headerList.get("x-forwarded-host") ?? headerList.get("host");
  const protocol = headerList.get("x-forwarded-proto") ?? "https";
  const baseUrl = host ? `${protocol}://${host}` : "";
  const cookie = headerList.get("cookie") ?? undefined;

  let initialEnvVarsContent: string | null = null;
  let initialMaintenanceScript: string | null = null;
  let initialDevScript: string | null = null;

  if (environmentId && baseUrl) {
    const headersInit = new Headers();
    headersInit.set("accept", "application/json");
    if (cookie) {
      headersInit.set("cookie", cookie);
    }

    try {
      const envRes = await fetch(
        `${baseUrl}/api/environments/${environmentId}?teamSlugOrId=${selectedTeamSlugOrId}`,
        { headers: headersInit, cache: "no-store" }
      );
      if (envRes.ok) {
        const envData = await envRes.json();
        initialMaintenanceScript = envData.maintenanceScript ?? null;
        initialDevScript = envData.devScript ?? null;
      }
    } catch (error) {
      console.error("Failed to fetch environment details", error);
    }

    try {
      const varsRes = await fetch(
        `${baseUrl}/api/environments/${environmentId}/vars?teamSlugOrId=${selectedTeamSlugOrId}`,
        { headers: headersInit, cache: "no-store" }
      );
      if (varsRes.ok) {
        const varsData = await varsRes.json();
        if (typeof varsData.envVarsContent === "string") {
          initialEnvVarsContent = varsData.envVarsContent;
        }
      }
    } catch (error) {
      console.error("Failed to fetch environment vars", error);
    }
  }

  return (
    <PreviewConfigureClient
      initialTeamSlugOrId={selectedTeamSlugOrId}
      teams={clientTeams}
      repo={repo}
      installationId={installationId}
      initialFrameworkPreset={detectedFrameworkPreset}
      initialEnvVarsContent={initialEnvVarsContent}
      initialMaintenanceScript={initialMaintenanceScript}
      initialDevScript={initialDevScript}
      startAtConfigureEnvironment={Boolean(environmentId)}
    />
  );
}
