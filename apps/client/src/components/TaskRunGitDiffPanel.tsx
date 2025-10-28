import { useMemo } from "react";
import { useQueries } from "@tanstack/react-query";
import { MonacoGitDiffViewer } from "./monaco/monaco-git-diff-viewer";
import { gitDiffQueryOptions } from "@/queries/git-diff";
import { normalizeGitRef } from "@/lib/refWithOrigin";
import type { TaskRunWithChildren } from "@/types/task";
import type { Doc } from "@cmux/convex/dataModel";

export interface TaskRunGitDiffPanelProps {
  task: Doc<"tasks"> | null | undefined;
  selectedRun: TaskRunWithChildren | null | undefined;
}

export function TaskRunGitDiffPanel({ task, selectedRun }: TaskRunGitDiffPanelProps) {
  const normalizedBaseBranch = useMemo(() => {
    const candidate = task?.baseBranch;
    if (candidate && candidate.trim()) {
      return normalizeGitRef(candidate);
    }
    return normalizeGitRef("main");
  }, [task?.baseBranch]);

  const normalizedHeadBranch = useMemo(
    () => normalizeGitRef(selectedRun?.newBranch),
    [selectedRun?.newBranch],
  );

  const environmentRepos = useMemo<string[]>(() => {
    const repos = selectedRun?.environment?.selectedRepos ?? [];
    const trimmed = repos
      .map((repo: string | undefined) => repo?.trim())
      .filter((repo): repo is string => Boolean(repo));
    return Array.from(new Set(trimmed));
  }, [selectedRun]);

  const repoFullNames = useMemo(() => {
    const names = new Set<string>();
    if (task?.projectFullName?.trim()) {
      names.add(task.projectFullName.trim());
    }
    for (const repo of environmentRepos) {
      names.add(repo);
    }
    return Array.from(names);
  }, [task?.projectFullName, environmentRepos]);

  const diffQueries = useQueries({
    queries: repoFullNames.map((repoFullName) => ({
      ...gitDiffQueryOptions({
        repoFullName,
        baseRef: normalizedBaseBranch || undefined,
        headRef: normalizedHeadBranch ?? "",
      }),
      enabled:
        Boolean(repoFullName?.trim()) && Boolean(normalizedHeadBranch?.trim()),
    })),
  });

  const allDiffs = useMemo(() => {
    return diffQueries.flatMap((query) => query.data ?? []);
  }, [diffQueries]);

  const isLoading = diffQueries.some((query) => query.isLoading);
  const hasError = diffQueries.some((query) => query.isError);

  if (!selectedRun || !normalizedHeadBranch) {
    return (
      <div className="flex h-full items-center justify-center px-4 text-center text-sm text-neutral-500 dark:text-neutral-400">
        Select a run to view git diffs
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center px-4 text-center text-sm text-neutral-500 dark:text-neutral-400">
        Loading diffs...
      </div>
    );
  }

  if (hasError) {
    return (
      <div className="flex h-full items-center justify-center px-4 text-center text-sm text-neutral-500 dark:text-neutral-400">
        Failed to load diffs
      </div>
    );
  }

  if (allDiffs.length === 0) {
    return (
      <div className="flex h-full items-center justify-center px-4 text-center text-sm text-neutral-500 dark:text-neutral-400">
        No changes found
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto">
      <MonacoGitDiffViewer diffs={allDiffs} />
    </div>
  );
}
