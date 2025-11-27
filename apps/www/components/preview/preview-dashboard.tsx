"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  Camera,
  Github,
  GitCompare,
  Loader2,
  Search,
  Server,
  Shield,
  User,
} from "lucide-react";
import Link from "next/link";
import clsx from "clsx";
import { Button } from "@/components/ui/button";

type ProviderConnection = {
  installationId: number;
  accountLogin: string | null;
  accountType: string | null;
  isActive: boolean;
};

type RepoSearchResult = {
  name: string;
  full_name: string;
  private: boolean;
  updated_at?: string | null;
  pushed_at?: string | null;
};

type PreviewConfigStatus = "active" | "paused" | "disabled";

type PreviewConfigListItem = {
  id: string;
  repoFullName: string;
  environmentId: string | null;
  repoInstallationId: number | null;
  repoDefaultBranch: string | null;
  status: PreviewConfigStatus;
  lastRunAt: number | null;
  teamSlugOrId: string;
  teamName: string;
};

type TeamOption = {
  slugOrId: string;
  displayName: string;
};

type PreviewDashboardProps = {
  selectedTeamSlugOrId: string;
  teamOptions: TeamOption[];
  providerConnectionsByTeam: Record<string, ProviderConnection[]>;
  isAuthenticated: boolean;
  previewConfigs: PreviewConfigListItem[];
};

const ADD_INSTALLATION_VALUE = "__add_github_account__";

export function PreviewDashboard({
  selectedTeamSlugOrId,
  teamOptions,
  providerConnectionsByTeam,
  isAuthenticated,
  previewConfigs,
}: PreviewDashboardProps) {
  const [selectedTeamSlugOrIdState, setSelectedTeamSlugOrIdState] = useState(
    () => selectedTeamSlugOrId || teamOptions[0]?.slugOrId || "",
  );
  const [isInstallingApp, setIsInstallingApp] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);

  // Repository selection state
  const [selectedInstallationId, setSelectedInstallationId] = useState<number | null>(null);
  const [repoSearch, setRepoSearch] = useState("");
  const [repos, setRepos] = useState<RepoSearchResult[]>([]);
  const [isLoadingRepos, setIsLoadingRepos] = useState(false);
  const [isNavigating, setIsNavigating] = useState(false);
  const [configs, setConfigs] = useState<PreviewConfigListItem[]>(previewConfigs);
  const [updatingConfigId, setUpdatingConfigId] = useState<string | null>(null);
  const [openingConfigId, setOpeningConfigId] = useState<string | null>(null);

  // Public URL input state
  const [repoUrlInput, setRepoUrlInput] = useState("");

  const currentProviderConnections = useMemo(
    () => providerConnectionsByTeam[selectedTeamSlugOrIdState] ?? [],
    [providerConnectionsByTeam, selectedTeamSlugOrIdState]
  );
  const activeConnections = useMemo(
    () => currentProviderConnections.filter((connection) => connection.isActive),
    [currentProviderConnections]
  );
  const previousTeamRef = useRef(selectedTeamSlugOrIdState);
  const hasGithubAppInstallation = activeConnections.length > 0;
  const canSearchRepos =
    isAuthenticated &&
    Boolean(selectedTeamSlugOrIdState) &&
    hasGithubAppInstallation &&
    activeConnections.length > 0;
  const searchPlaceholder = !isAuthenticated
    ? "Sign in to search your GitHub repos"
    : !selectedTeamSlugOrIdState
      ? "Select a team to search repos"
      : !hasGithubAppInstallation
        ? "Install the GitHub App to search your repos"
        : "Search installed repositories";

  useEffect(() => {
    setConfigs(previewConfigs);
  }, [previewConfigs]);

  // Parse GitHub URL to extract owner/repo
  const parseGithubUrl = useCallback((input: string): string | null => {
    const trimmed = input.trim();
    // Try to parse as URL
    try {
      const url = new URL(trimmed);
      if (url.hostname === "github.com" || url.hostname === "www.github.com") {
        const parts = url.pathname.split("/").filter(Boolean);
        if (parts.length >= 2) {
          return `${parts[0]}/${parts[1]}`;
        }
      }
    } catch {
      // Not a valid URL, check if it's owner/repo format
      const ownerRepoMatch = trimmed.match(/^([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)$/);
      if (ownerRepoMatch) {
        return trimmed;
      }
    }
    return null;
  }, []);

  const formatLastRun = useCallback((timestamp: number | null) => {
    if (!timestamp) return "No runs yet";
    const diffMs = Date.now() - timestamp;
    if (diffMs < 60_000) return "Just now";
    const diffMinutes = Math.floor(diffMs / 60_000);
    if (diffMinutes < 60) return `${diffMinutes}m ago`;
    const diffHours = Math.floor(diffMinutes / 60);
    if (diffHours < 24) return `${diffHours}h ago`;
    const diffDays = Math.floor(diffHours / 24);
    return `${diffDays}d ago`;
  }, []);

  const handleOpenConfig = useCallback((config: PreviewConfigListItem) => {
    setOpeningConfigId(config.id);
    const params = new URLSearchParams({
      repo: config.repoFullName,
      team: config.teamSlugOrId,
    });
    if (config.repoInstallationId !== null) {
      params.set("installationId", String(config.repoInstallationId));
    }
    if (config.environmentId) {
      params.set("environmentId", config.environmentId);
    }
    window.location.href = `/preview/configure?${params.toString()}`;
  }, []);

  const handleDeleteConfig = useCallback(
    async (config: PreviewConfigListItem) => {
      setUpdatingConfigId(config.id);
      setConfigError(null);
      try {
        const params = new URLSearchParams({ teamSlugOrId: config.teamSlugOrId });
        const response = await fetch(`/api/preview/configs/${config.id}?${params.toString()}`, {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
        });
        if (!response.ok) {
          throw new Error(await response.text());
        }
        setConfigs((previous) => previous.filter((item) => item.id !== config.id));
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Failed to delete preview configuration";
        setConfigError(message);
      } finally {
        setUpdatingConfigId(null);
      }
    },
    []
  );

  const handleTeamChange = useCallback(
    (nextTeam: string) => {
      setSelectedTeamSlugOrIdState(nextTeam);
      setSelectedInstallationId(null);
      setRepoSearch("");
      setErrorMessage(null);
    },
    []
  );

  const handleStartPreview = useCallback(async () => {
    if (!selectedTeamSlugOrIdState) {
      setErrorMessage("Select a team before continuing.");
      return;
    }

    const repoName = parseGithubUrl(repoUrlInput);
    if (!repoName) {
      setErrorMessage("Please enter a valid GitHub URL or owner/repo");
      return;
    }
    const params = new URLSearchParams({ repo: repoName });
    params.set("team", selectedTeamSlugOrIdState);
    const configurePath = `/preview/configure?${params.toString()}`;

    if (!isAuthenticated) {
      setErrorMessage(null);
      setIsNavigating(true);
      window.location.href = `/handler/sign-in?after_auth_return_to=${encodeURIComponent(configurePath)}`;
      return;
    }

    if (!hasGithubAppInstallation) {
      setErrorMessage(null);
      setIsInstallingApp(true);
      setIsNavigating(true);

      try {
        try {
          sessionStorage.setItem("pr_review_return_url", configurePath);
        } catch (storageError) {
          console.warn("[PreviewDashboard] Failed to persist return URL", storageError);
        }

        const response = await fetch("/api/integrations/github/install-state", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            teamSlugOrId: selectedTeamSlugOrIdState,
            returnUrl: new URL(configurePath, window.location.origin).toString(),
          }),
        });

        if (!response.ok) {
          throw new Error(await response.text());
        }

        const payload = (await response.json()) as { state: string };
        const githubAppSlug = process.env.NEXT_PUBLIC_GITHUB_APP_SLUG;
        if (!githubAppSlug) {
          throw new Error("GitHub App slug is not configured");
        }

        const url = new URL(`https://github.com/apps/${githubAppSlug}/installations/new`);
        url.searchParams.set("state", payload.state);
        window.location.href = url.toString();
        return;
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Failed to start GitHub App install";
        setErrorMessage(message);
        setIsInstallingApp(false);
        setIsNavigating(false);
        return;
      }
    }

    setErrorMessage(null);
    setIsNavigating(true);
    window.location.href = configurePath;
  }, [
    repoUrlInput,
    parseGithubUrl,
    selectedTeamSlugOrIdState,
    hasGithubAppInstallation,
    isAuthenticated,
  ]);

  // Auto-select first connection for the team, but keep user choice if still valid
  useEffect(() => {
    const fallbackInstallationId = activeConnections[0]?.installationId ?? null;
    const teamChanged = previousTeamRef.current !== selectedTeamSlugOrIdState;
    const hasSelectedConnection = activeConnections.some(
      (connection) => connection.installationId === selectedInstallationId
    );

    if (activeConnections.length === 0) {
      if (selectedInstallationId !== null) {
        setSelectedInstallationId(null);
      }
    } else if (teamChanged || !hasSelectedConnection) {
      if (selectedInstallationId !== fallbackInstallationId) {
        setSelectedInstallationId(fallbackInstallationId);
      }
    }

    previousTeamRef.current = selectedTeamSlugOrIdState;
  }, [activeConnections, selectedInstallationId, selectedTeamSlugOrIdState]);

  const handleInstallGithubApp = async () => {
    if (!selectedTeamSlugOrIdState) {
      setErrorMessage("Select a team first");
      return;
    }
    setIsInstallingApp(true);
    setErrorMessage(null);
    try {
      const currentUrl = window.location.href;
      try {
        sessionStorage.setItem("pr_review_return_url", currentUrl);
      } catch (storageError) {
        console.warn("[PreviewDashboard] Failed to persist return URL", storageError);
      }

      const response = await fetch("/api/integrations/github/install-state", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          teamSlugOrId: selectedTeamSlugOrIdState,
          returnUrl: currentUrl,
        }),
      });
      if (!response.ok) {
        throw new Error(await response.text());
      }
      const payload = (await response.json()) as { installUrl: string };
      window.location.href = payload.installUrl;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to start GitHub App install";
      setErrorMessage(message);
      setIsInstallingApp(false);
    }
  };

  const fetchRepos = useCallback(
    async (searchTerm: string) => {
      if (!canSearchRepos || selectedInstallationId === null) {
        setRepos([]);
        return;
      }
      setIsLoadingRepos(true);
      setErrorMessage(null);
      try {
        const params = new URLSearchParams({
          team: selectedTeamSlugOrIdState,
          installationId: String(selectedInstallationId),
        });
        const trimmed = searchTerm.trim();
        if (trimmed) {
          params.set("search", trimmed);
        }
        const response = await fetch(`/api/integrations/github/repos?${params.toString()}`);
        if (!response.ok) {
          throw new Error(await response.text());
        }
        const payload = (await response.json()) as { repos: RepoSearchResult[] };
        setRepos(payload.repos);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to load repositories";
        setErrorMessage(message);
      } finally {
        setIsLoadingRepos(false);
      }
    },
    [canSearchRepos, selectedInstallationId, selectedTeamSlugOrIdState]
  );

  const handleSearchRepos = useCallback(() => {
    void fetchRepos(repoSearch);
  }, [fetchRepos, repoSearch]);

  const handleContinue = useCallback((repoName: string) => {
    if (!repoName.trim()) return;
    setIsNavigating(true);
    const params = new URLSearchParams({
      repo: repoName,
      installationId: String(selectedInstallationId ?? ""),
      team: selectedTeamSlugOrIdState,
    });
    window.location.href = `/preview/configure?${params.toString()}`;
  }, [selectedInstallationId, selectedTeamSlugOrIdState]);

  useEffect(() => {
    if (selectedInstallationId !== null) {
      void fetchRepos("");
    } else {
      setRepos([]);
    }
  }, [selectedInstallationId, fetchRepos]);

  useEffect(() => {
    if (!selectedTeamSlugOrIdState && teamOptions[0]) {
      setSelectedTeamSlugOrIdState(teamOptions[0].slugOrId);
    }
  }, [selectedTeamSlugOrIdState, teamOptions]);

  return (
    <div className="mx-auto w-full max-w-[1200px] px-6 py-12">
      <div className="mb-12 space-y-5">
        <div className="flex items-center gap-4">
          <Link
            href="https://cmux.dev"
            className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-sm text-neutral-200 transition hover:border-white/20 hover:text-white"
          >
            <ArrowLeft className="h-4 w-4" />
            <span>Back to cmux</span>
          </Link>
        </div>

        <div className="space-y-3">
          <h1 className="text-4xl font-bold tracking-tight text-white sm:text-5xl">
            Screenshot previews for your PRs
          </h1>
          <p className="max-w-3xl text-lg text-neutral-300">
            preview.new sets up a GitHub agent that takes screenshot previews of your dev server so you
            can visually verify your pull requests.
          </p>
        </div>
      </div>

      <div
        id="setup-preview"
        className="relative mb-12 overflow-hidden rounded-2xl border border-white/10 bg-white/5 p-6 shadow-2xl backdrop-blur"
      >
        <div className="absolute -left-32 -top-24 h-64 w-64 rounded-full bg-sky-500/20 blur-3xl" />
        <div className="absolute -right-28 bottom-0 h-56 w-56 rounded-full bg-purple-500/20 blur-3xl" />
        <div className="relative space-y-4">
          <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <div className="space-y-2">
              <p className="text-sm font-semibold text-white">Setup a preview</p>
              <p className="text-sm text-neutral-300">
                Paste a public GitHub URL to setup screenshot previews.
              </p>
              {!isAuthenticated && (
                <p className="text-xs text-neutral-400">
                  Sign in to connect private repos and keep captures tied to your workspace.
                </p>
              )}
            </div>
            <div className="flex w-full flex-col gap-3 sm:min-w-[320px] sm:flex-row sm:items-center md:min-w-[420px]">
              <div className="relative w-full">
                <Github className="absolute left-3 top-3 h-4 w-4 text-neutral-500" />
                <input
                  type="text"
                  value={repoUrlInput}
                  onChange={(e) => setRepoUrlInput(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && void handleStartPreview()}
                  placeholder="https://github.com/owner/repo"
                  className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2.5 pl-10 text-sm text-white placeholder:text-neutral-500 focus:border-white/20 focus:outline-none focus:ring-1 focus:ring-sky-500/50"
                />
              </div>
              <Button
                onClick={() => void handleStartPreview()}
                disabled={!repoUrlInput.trim() || isNavigating || !selectedTeamSlugOrIdState}
                className="bg-white text-black hover:bg-neutral-200"
              >
                {isNavigating ? "Loading…" : "Start"}
              </Button>
            </div>
          </div>
          {errorMessage && (
            <p className="text-xs text-red-400">{errorMessage}</p>
          )}
        </div>
      </div>

      <div className="grid gap-8 lg:grid-cols-[1.5fr_1fr]">
        {/* Left Column: Import Git Repository */}
        <div className="flex flex-col">
          <h2 className="text-xl font-semibold text-white">Choose a repository</h2>
          {isAuthenticated && teamOptions.length > 0 ? (
            <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
              <label className="text-sm text-neutral-300">Team</label>
              <div className="relative min-w-[220px]">
                <select
                  value={selectedTeamSlugOrIdState}
                  onChange={(e) => handleTeamChange(e.target.value)}
                  className="w-full appearance-none rounded-lg border border-white/10 bg-white/5 px-3 py-2.5 text-sm text-white focus:border-white/20 focus:outline-none focus:ring-1 focus:ring-sky-500/50"
                >
                  {teamOptions.map((team) => (
                    <option key={team.slugOrId} value={team.slugOrId}>
                      {team.displayName}
                    </option>
                  ))}
                </select>
                <div className="pointer-events-none absolute right-3 top-3">
                  <svg className="h-4 w-4 text-neutral-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                  </svg>
                </div>
              </div>
            </div>
          ) : null}

          <div className="mt-6 flex-1 rounded-xl border border-white/10 bg-neutral-900/30 p-6">
            {!isAuthenticated ? (
               <div className="text-center py-8">
                  <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-white/5">
                    <User className="h-6 w-6 text-white" />
                  </div>
                  <h3 className="mb-2 text-lg font-medium text-white">Sign in to continue</h3>
                  <p className="mb-6 text-sm text-neutral-400">
                    Sign in to preview.new to import your repositories and capture pull requests.
                  </p>
                  <Button asChild className="bg-white text-black hover:bg-neutral-200">
                    <Link href="/handler/sign-in?after_auth_return_to=/preview">
                      Sign In
                    </Link>
                  </Button>
               </div>
            ) : !hasGithubAppInstallation ? (
               <div className="text-center py-8">
                  <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-white/5">
                    <Github className="h-6 w-6 text-white" />
                  </div>
                  <h3 className="mb-2 text-lg font-medium text-white">Connect to GitHub</h3>
                  <p className="mb-6 text-sm text-neutral-400">
                    Install the preview.new GitHub App (cmux) to connect your repositories.
                  </p>
                  <Button
                    onClick={handleInstallGithubApp}
                    disabled={isInstallingApp}
                    className="inline-flex items-center gap-2 bg-white text-black hover:bg-neutral-200"
                  >
                    {isInstallingApp ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Shield className="h-4 w-4" />
                    )}
                    Install GitHub App
                  </Button>
                  {errorMessage && (
                    <p className="mt-4 text-xs text-red-400">{errorMessage}</p>
                  )}
               </div>
            ) : (
              <div className="space-y-4">
                <div className="flex gap-3">
                  {/* Team/Org Selector */}
                  <div className="relative min-w-[160px]">
                      <Github className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-neutral-500" />
                      <select
                        value={selectedInstallationId ?? ""}
                        onChange={(e) => {
                          const value = e.target.value;
                          if (value === ADD_INSTALLATION_VALUE) {
                            void handleInstallGithubApp();
                            return;
                          }
                          setSelectedInstallationId(Number(value));
                        }}
                        className="w-full appearance-none rounded-lg border border-white/10 bg-white/5 px-3 py-2.5 pl-10 text-sm text-white focus:border-white/20 focus:outline-none focus:ring-1 focus:ring-sky-500/50"
                      >
                        {activeConnections.map((conn) => (
                          <option key={conn.installationId} value={conn.installationId}>
                            {conn.accountLogin || `ID: ${conn.installationId}`}
                          </option>
                        ))}
                        <option value={ADD_INSTALLATION_VALUE}>Add GitHub account</option>
                      </select>
                      <div className="pointer-events-none absolute right-3 top-3">
                         <svg className="h-4 w-4 text-neutral-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                           <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                         </svg>
                      </div>
                   </div>

                   {/* Repo Search */}
                   <div className="relative flex-1">
                     <Search className="absolute left-3 top-2.5 h-4 w-4 text-neutral-500" />
                     <input
                       type="text"
                       value={repoSearch}
                       onChange={(e) => setRepoSearch(e.target.value)}
                       onKeyDown={(e) => e.key === "Enter" && void handleSearchRepos()}
                       placeholder={searchPlaceholder}
                       disabled={!canSearchRepos}
                       className="w-full rounded-lg border border-white/10 bg-white/5 pl-9 pr-3 py-2.5 text-sm text-white focus:border-white/20 focus:outline-none focus:ring-1 focus:ring-sky-500/50 disabled:cursor-not-allowed disabled:opacity-50"
                     />
                  </div>
               </div>

                {/* Repo List */}
                <div className="repo-scroll-area min-h-[300px] max-h-[520px] overflow-y-auto -mr-6 pr-6">
                  {!canSearchRepos ? (
                    <div className="flex h-full min-h-[200px] items-center justify-center text-sm text-neutral-400">
                      Select a team and install the GitHub App to search repositories.
                    </div>
                  ) : isLoadingRepos ? (
                    <div className="flex justify-center py-12">
                      <Loader2 className="h-6 w-6 animate-spin text-neutral-500" />
                    </div>
                  ) : repos.length > 0 ? (
                    <div className="space-y-2">
                      {repos.map((repo) => {
                        const daysAgo = repo.updated_at
                          ? Math.floor((Date.now() - new Date(repo.updated_at).getTime()) / (1000 * 60 * 60 * 24))
                          : null;
                        return (
                          <div
                            key={repo.full_name}
                            className="flex items-center justify-between rounded-lg border border-white/5 bg-white/5 px-4 py-3 transition hover:border-white/10 hover:bg-white/10"
                          >
                            <div className="flex items-center gap-3">
                               <div className="flex h-8 w-8 items-center justify-center rounded-md bg-black/40">
                                 <Github className="h-4 w-4 text-white" />
                               </div>
                               <div>
                                 <div className="text-sm font-medium text-white">{repo.full_name}</div>
                                 {daysAgo !== null && (
                                   <div className="text-xs text-neutral-500">{daysAgo}d ago</div>
                                 )}
                               </div>
                            </div>
                            <Button
                              onClick={() => handleContinue(repo.full_name)}
                              disabled={isNavigating || !selectedInstallationId}
                              size="sm"
                              className="bg-white text-black hover:bg-neutral-200"
                            >
                              Import
                            </Button>
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="flex flex-col items-center justify-center py-12 text-sm text-neutral-500">
                      <p>No repositories found</p>
                      <button onClick={() => void handleSearchRepos()} className="mt-2 text-sky-400 hover:underline">
                        Refresh
                      </button>
                    </div>
                  )}
                </div>

              </div>
            )}
          </div>
        </div>

        {/* Right Column: What is preview.new? */}
        <div className="flex flex-col">
          <h2 className="text-xl font-semibold text-white">What is preview.new?</h2>
          <div className="mt-6 flex flex-1 flex-col gap-4">
            <div className="flex-1 rounded-xl border border-white/10 bg-neutral-900/30 p-4">
              <div className="mb-2 flex items-center gap-3">
                <div className="rounded-lg bg-sky-500/20 p-2 text-sky-400">
                  <Camera className="h-5 w-5" />
                </div>
                <h4 className="font-medium text-white">Automated captures</h4>
              </div>
              <p className="text-sm text-neutral-400">
                Every PR triggers a dedicated VM that boots your dev server and captures screenshots automatically.
              </p>
            </div>

            <div className="flex-1 rounded-xl border border-white/10 bg-neutral-900/30 p-4">
              <div className="mb-2 flex items-center gap-3">
                <div className="rounded-lg bg-emerald-500/20 p-2 text-emerald-400">
                  <GitCompare className="h-5 w-5" />
                </div>
                <h4 className="font-medium text-white">Visual verification</h4>
              </div>
              <p className="text-sm text-neutral-400">
                Catch visual regressions and UI bugs before they ship by comparing screenshots across profiles.
              </p>
            </div>

            <div className="flex-1 rounded-xl border border-white/10 bg-neutral-900/30 p-4">
              <div className="mb-2 flex items-center gap-3">
                <div className="rounded-lg bg-purple-500/20 p-2 text-purple-400">
                  <Server className="h-5 w-5" />
                </div>
                <h4 className="font-medium text-white">Isolated VMs</h4>
              </div>
              <p className="text-sm text-neutral-400">
                Each PR spins up a dedicated VM that runs your dev server exactly as it would locally.
              </p>
            </div>
          </div>
        </div>
      </div>

      {isAuthenticated ? (
        <div className="mt-10 rounded-2xl border border-white/10 bg-white/5 p-6 shadow-2xl backdrop-blur">
          <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-sm font-semibold text-white">Preview agent configurations</p>
              <p className="text-sm text-neutral-300">
                Update or delete existing preview setups across your teams.
              </p>
            </div>
            {configError ? (
              <span className="text-xs text-red-400">{configError}</span>
            ) : null}
          </div>

          {configs.length === 0 ? (
            <div className="rounded-xl border border-white/10 bg-black/30 p-5 text-sm text-neutral-300">
              No preview configs yet. Choose a repository to create one.
            </div>
          ) : (
            <div className="space-y-3">
              {configs.map((config) => (
                <div
                  key={config.id}
                  className="flex flex-col gap-3 rounded-xl border border-white/10 bg-black/30 p-5 md:flex-row md:items-center md:justify-between"
                >
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <Github className="h-4 w-4 text-white" />
                      <span className="text-sm font-semibold text-white">{config.repoFullName}</span>
                      <span className="rounded-full border border-white/10 bg-white/10 px-2 py-0.5 text-[10px] uppercase tracking-wide text-neutral-200">
                        {config.teamName}
                      </span>
                    </div>
                    <div className="flex flex-wrap items-center gap-2 text-xs text-neutral-400">
                      <span>Last run: {formatLastRun(config.lastRunAt)}</span>
                      <span
                        className={clsx(
                          "rounded-full border px-2 py-0.5 font-medium capitalize",
                          config.status === "active"
                            ? "border-emerald-500/50 bg-emerald-500/20 text-emerald-100"
                            : config.status === "paused"
                              ? "border-amber-500/50 bg-amber-500/20 text-amber-100"
                              : "border-neutral-500/50 bg-neutral-500/20 text-neutral-100"
                        )}
                      >
                        {config.status}
                      </span>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="outline"
                      onClick={() => handleOpenConfig(config)}
                      disabled={openingConfigId === config.id}
                      className="border-white/30 bg-white/10 text-white hover:border-white/60 hover:bg-white/20"
                    >
                      {openingConfigId === config.id ? (
                        <div className="flex items-center gap-2">
                          <Loader2 className="h-4 w-4 animate-spin" />
                          <span>Opening…</span>
                        </div>
                      ) : (
                        "Update"
                      )}
                    </Button>
                    <Button
                      onClick={() => void handleDeleteConfig(config)}
                      disabled={updatingConfigId === config.id}
                      className={clsx(
                        "bg-red-500 text-white hover:bg-red-600",
                        updatingConfigId === config.id && "opacity-70"
                      )}
                    >
                      {updatingConfigId === config.id ? (
                        <div className="flex items-center gap-2">
                          <Loader2 className="h-4 w-4 animate-spin" />
                          <span>Deleting…</span>
                        </div>
                      ) : (
                        "Delete"
                      )}
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
