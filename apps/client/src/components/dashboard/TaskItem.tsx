import { OpenWithDropdown } from "@/components/OpenWithDropdown";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useArchiveTask } from "@/hooks/useArchiveTask";
import { useTaskRename } from "@/hooks/useTaskRename";
import { isFakeConvexId } from "@/lib/fakeConvexId";
import type { RunEnvironmentSummary } from "@/types/task";
import { ContextMenu } from "@base-ui-components/react/context-menu";
import type { DbTask } from "@cmux/www-openapi-client";
import {
  getApiTaskRunsOptions,
  getApiTasksOptions,
  getApiTasksPinnedOptions,
} from "@cmux/www-openapi-client/react-query";
import {
  postApiTasksByIdPin,
  postApiTasksByIdUnpin,
} from "@cmux/www-openapi-client";
import { useClipboard } from "@mantine/hooks";
import { useMutation, useQueryClient, useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import clsx from "clsx";
// Read team slug from path to avoid route type coupling
import {
  Archive,
  ArchiveRestore,
  Box,
  Check,
  Copy,
  GitMerge,
  Loader2,
  Pencil,
  Pin,
  PinOff,
} from "lucide-react";
import { memo, useCallback, useMemo } from "react";
import { EnvironmentName } from "./EnvironmentName";

interface TaskItemProps {
  task: DbTask;
  teamSlugOrId: string;
}

export const TaskItem = memo(function TaskItem({
  task,
  teamSlugOrId,
}: TaskItemProps) {
  const clipboard = useClipboard({ timeout: 2000 });
  const queryClient = useQueryClient();
  const { archiveWithUndo, unarchive, isArchiving } =
    useArchiveTask(teamSlugOrId);
  const taskIsArchiving = isArchiving(task.id);
  const navigate = useNavigate();
  // Detect optimistic update (UUID format)
  const isOptimisticUpdate = task.id.includes("-") && task.id.length === 36;
  const canRename = !isOptimisticUpdate;

  const {
    isRenaming,
    renameValue,
    renameError,
    isRenamePending,
    renameInputRef,
    handleRenameChange,
    handleRenameKeyDown,
    handleRenameBlur,
    handleRenameFocus,
    handleStartRenaming,
  } = useTaskRename({
    taskId: task.id,
    teamSlugOrId,
    currentText: task.text,
    canRename,
  });

  // Query for task runs to find VSCode instances
  const isFake = isFakeConvexId(task.id);
  const taskRunsResult = useQuery({
    ...getApiTaskRunsOptions({ query: { taskId: task.id } }),
    enabled: !isFake,
  });
  const taskRunsQuery = taskRunsResult.data?.taskRuns as Array<Record<string, unknown>> | undefined;

  // Check if task has a crown based on crownEvaluationStatus
  const hasCrown = (task as Record<string, unknown>).crownEvaluationStatus === "succeeded";

  // Mutation for toggling keep-alive status
  // TODO: No HTTP API endpoint for keep-alive yet; this is a no-op placeholder
  const toggleKeepAlive = useMutation({
    mutationFn: async (_args: { teamSlugOrId: string; id: string; keepAlive: boolean }) => {
      console.warn("toggleKeepAlive: no HTTP API endpoint available yet");
    },
  });

  // Mutations for pinning/unpinning tasks with optimistic updates
  const pinTask = useMutation({
    mutationFn: async ({ teamSlugOrId: team, id }: { teamSlugOrId: string; id: string }) => {
      await postApiTasksByIdPin({ path: { id }, body: { teamSlugOrId: team } });
    },
    onMutate: async (args) => {
      const tasksQueryKey = getApiTasksOptions({ query: { teamSlugOrId: args.teamSlugOrId } }).queryKey;
      const pinnedQueryKey = getApiTasksPinnedOptions({ query: { teamSlugOrId: args.teamSlugOrId } }).queryKey;

      await queryClient.cancelQueries({ queryKey: tasksQueryKey });
      await queryClient.cancelQueries({ queryKey: pinnedQueryKey });

      const previousTasks = queryClient.getQueryData(tasksQueryKey);
      const previousPinned = queryClient.getQueryData(pinnedQueryKey);

      queryClient.setQueryData(tasksQueryKey, (old: { tasks: DbTask[] } | undefined) => {
        if (!old) return old;
        return { tasks: old.tasks.map(t => t.id === args.id ? { ...t, pinned: true, updatedAt: Date.now() } : t) };
      });

      queryClient.setQueryData(pinnedQueryKey, (old: { tasks: DbTask[] } | undefined) => {
        if (!old) return old;
        const taskToPin = (previousTasks as { tasks: DbTask[] } | undefined)?.tasks.find(t => t.id === args.id);
        if (taskToPin) {
          return { tasks: [{ ...taskToPin, pinned: true, updatedAt: Date.now() }, ...old.tasks] };
        }
        return old;
      });

      return { previousTasks, previousPinned };
    },
    onError: (_err, args, context) => {
      if (context?.previousTasks) {
        queryClient.setQueryData(getApiTasksOptions({ query: { teamSlugOrId: args.teamSlugOrId } }).queryKey, context.previousTasks);
      }
      if (context?.previousPinned) {
        queryClient.setQueryData(getApiTasksPinnedOptions({ query: { teamSlugOrId: args.teamSlugOrId } }).queryKey, context.previousPinned);
      }
    },
    onSettled: (_data, _error, args) => {
      void queryClient.invalidateQueries({ queryKey: getApiTasksOptions({ query: { teamSlugOrId: args.teamSlugOrId } }).queryKey });
      void queryClient.invalidateQueries({ queryKey: getApiTasksPinnedOptions({ query: { teamSlugOrId: args.teamSlugOrId } }).queryKey });
    },
  });

  const unpinTask = useMutation({
    mutationFn: async ({ teamSlugOrId: team, id }: { teamSlugOrId: string; id: string }) => {
      await postApiTasksByIdUnpin({ path: { id }, body: { teamSlugOrId: team } });
    },
    onMutate: async (args) => {
      const tasksQueryKey = getApiTasksOptions({ query: { teamSlugOrId: args.teamSlugOrId } }).queryKey;
      const pinnedQueryKey = getApiTasksPinnedOptions({ query: { teamSlugOrId: args.teamSlugOrId } }).queryKey;

      await queryClient.cancelQueries({ queryKey: tasksQueryKey });
      await queryClient.cancelQueries({ queryKey: pinnedQueryKey });

      const previousTasks = queryClient.getQueryData(tasksQueryKey);
      const previousPinned = queryClient.getQueryData(pinnedQueryKey);

      queryClient.setQueryData(tasksQueryKey, (old: { tasks: DbTask[] } | undefined) => {
        if (!old) return old;
        return { tasks: old.tasks.map(t => t.id === args.id ? { ...t, pinned: false, updatedAt: Date.now() } : t) };
      });

      queryClient.setQueryData(pinnedQueryKey, (old: { tasks: DbTask[] } | undefined) => {
        if (!old) return old;
        return { tasks: old.tasks.filter(t => t.id !== args.id) };
      });

      return { previousTasks, previousPinned };
    },
    onError: (_err, args, context) => {
      if (context?.previousTasks) {
        queryClient.setQueryData(getApiTasksOptions({ query: { teamSlugOrId: args.teamSlugOrId } }).queryKey, context.previousTasks);
      }
      if (context?.previousPinned) {
        queryClient.setQueryData(getApiTasksPinnedOptions({ query: { teamSlugOrId: args.teamSlugOrId } }).queryKey, context.previousPinned);
      }
    },
    onSettled: (_data, _error, args) => {
      void queryClient.invalidateQueries({ queryKey: getApiTasksOptions({ query: { teamSlugOrId: args.teamSlugOrId } }).queryKey });
      void queryClient.invalidateQueries({ queryKey: getApiTasksPinnedOptions({ query: { teamSlugOrId: args.teamSlugOrId } }).queryKey });
    },
  });

  // Find the latest task run with a VSCode instance
  const getLatestVSCodeInstance = useCallback(() => {
    if (!taskRunsQuery || taskRunsQuery.length === 0) return null;

    // Define task run type with nested structure
    interface TaskRunWithChildren {
      id: string;
      createdAt?: number | null;
      vscode?: { status?: string; url?: string; keepAlive?: boolean; provider?: string } | null;
      worktreePath?: string | null;
      children?: TaskRunWithChildren[];
      environment?: RunEnvironmentSummary | null;
      [key: string]: unknown;
    }

    // Flatten all task runs (including children)
    const allRuns: TaskRunWithChildren[] = [];
    const flattenRuns = (runs: TaskRunWithChildren[]) => {
      runs.forEach((run) => {
        allRuns.push(run);
        if (run.children) {
          flattenRuns(run.children);
        }
      });
    };
    flattenRuns(taskRunsQuery as TaskRunWithChildren[]);

    // Find the most recent run with VSCode instance that's running or starting
    const runWithVSCode = allRuns
      .filter(
        (run) =>
          run.vscode &&
          (run.vscode.status === "running" || run.vscode.status === "starting")
      )
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))[0];

    return runWithVSCode;
  }, [taskRunsQuery]);

  const runWithVSCode = useMemo(
    () => getLatestVSCodeInstance(),
    [getLatestVSCodeInstance]
  );
  const hasActiveVSCode = runWithVSCode?.vscode?.status === "running";

  // Generate the VSCode URL if available (use base URL, not workspaceUrl)
  const vscodeUrl = useMemo(() => {
    if (hasActiveVSCode && runWithVSCode?.vscode?.url) {
      return runWithVSCode.vscode.url;
    }
    return null;
  }, [hasActiveVSCode, runWithVSCode]);
  const vscodeProvider = runWithVSCode?.vscode?.provider as "docker" | "morph" | "incus" | "aws" | "daytona" | "other" | undefined;

  // For local workspaces, find the run with VSCode to navigate to VSCode view directly
  const localWorkspaceRunWithVscode = useMemo(() => {
    if (!task.isLocalWorkspace) {
      return null;
    }
    if (!hasActiveVSCode || !runWithVSCode) {
      return null;
    }
    return runWithVSCode;
  }, [task.isLocalWorkspace, hasActiveVSCode, runWithVSCode]);

  const handleLinkClick = useCallback(
    (event: React.MouseEvent<HTMLAnchorElement>) => {
      // Don't navigate if we're renaming
      if (isRenaming || event.defaultPrevented) {
        event.preventDefault();
        return;
      }
      // Let browser handle modifier key clicks (cmd+click for new tab, etc.)
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
        return;
      }
      // For local workspaces with active VSCode, navigate to VSCode view directly
      if (localWorkspaceRunWithVscode) {
        event.preventDefault();
        void navigate({
          to: "/$teamSlugOrId/task/$taskId/run/$runId/vscode",
          params: {
            teamSlugOrId,
            taskId: task.id,
            runId: localWorkspaceRunWithVscode.id,
          },
        });
        return;
      }
    },
    [isRenaming, localWorkspaceRunWithVscode, navigate, teamSlugOrId, task.id]
  );

  const handleCopy = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      clipboard.copy(task.text);
    },
    [clipboard, task.text]
  );

  const handleCopyFromMenu = useCallback(() => {
    clipboard.copy(task.text);
  }, [clipboard, task.text]);

  const handleToggleKeepAlive = useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation();
      if (runWithVSCode) {
        await toggleKeepAlive.mutateAsync({
          teamSlugOrId,
          id: runWithVSCode.id,
          keepAlive: !runWithVSCode.vscode?.keepAlive,
        });
      }
    },
    [runWithVSCode, teamSlugOrId, toggleKeepAlive]
  );

  const handleArchive = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      archiveWithUndo(task);
    },
    [archiveWithUndo, task]
  );

  const handleArchiveFromMenu = useCallback(() => {
    archiveWithUndo(task);
  }, [archiveWithUndo, task]);

  const handleUnarchiveFromMenu = useCallback(() => {
    unarchive(task.id);
  }, [unarchive, task.id]);

  const handleUnarchive = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      unarchive(task.id);
    },
    [unarchive, task.id]
  );

  const handlePinFromMenu = useCallback(() => {
    pinTask.mutate({
      teamSlugOrId,
      id: task.id,
    });
  }, [pinTask, teamSlugOrId, task.id]);

  const handleUnpinFromMenu = useCallback(() => {
    unpinTask.mutate({
      teamSlugOrId,
      id: task.id,
    });
  }, [unpinTask, teamSlugOrId, task.id]);

  return (
    <div className="relative group w-full">
      <ContextMenu.Root>
        <ContextMenu.Trigger>
          <Link
            to="/$teamSlugOrId/task/$taskId"
            params={{ teamSlugOrId, taskId: task.id }}
            search={{ runId: undefined }}
            onClick={handleLinkClick}
            className={clsx(
              "relative grid w-full items-center py-2 pr-3 cursor-default select-none group",
              "grid-cols-[24px_36px_1fr_minmax(120px,auto)_58px]",
              isOptimisticUpdate
                ? "bg-white/50 dark:bg-neutral-900/30 animate-pulse"
                : "bg-white dark:bg-neutral-900/50 group-hover:bg-neutral-50/90 dark:group-hover:bg-neutral-600/60",
              isRenaming && "pr-2"
            )}
          >
            <div className="flex items-center justify-center pl-1 -mr-2 relative">
              <input
                type="checkbox"
                className="peer w-3 h-3 cursor-pointer border border-neutral-400 dark:border-neutral-500 rounded bg-white dark:bg-neutral-900 appearance-none checked:bg-neutral-500 checked:border-neutral-500 dark:checked:bg-neutral-400 dark:checked:border-neutral-400 invisible"
                onClick={(e) => e.stopPropagation()}
                onChange={() => {
                  // TODO: Implement checkbox functionality
                }}
              />
              <Check
                className="absolute w-2.5 h-2.5 text-white pointer-events-none transition-opacity peer-checked:opacity-100 opacity-0"
                style={{
                  left: "57%",
                  top: "50%",
                  transform: "translate(-50%, -50%)",
                }}
              />
            </div>
            <div className="flex items-center justify-center">
              {task.mergeStatus === "pr_merged" ? (
                <GitMerge className="w-3.5 h-3.5 text-purple-500 dark:text-purple-400 flex-shrink-0" />
              ) : task.isCloudWorkspace || task.isLocalWorkspace ? (
                <Box className="w-3.5 h-3.5 text-neutral-500 dark:text-neutral-400 flex-shrink-0" />
              ) : (
                <div
                  className={clsx(
                    "rounded-full flex-shrink-0",
                    hasCrown
                      ? "w-[8px] h-[8px] border border-transparent bg-green-500"
                      : "w-[9.5px] h-[9.5px] border border-neutral-400 dark:border-neutral-500 bg-transparent"
                  )}
                />
              )}
            </div>
            <div className="min-w-0 flex items-center">
              {isRenaming ? (
                <input
                  ref={renameInputRef}
                  type="text"
                  value={renameValue}
                  onChange={handleRenameChange}
                  onKeyDown={handleRenameKeyDown}
                  onBlur={handleRenameBlur}
                  disabled={isRenamePending}
                  autoFocus
                  onFocus={handleRenameFocus}
                  placeholder="Task name"
                  aria-label="Task name"
                  aria-invalid={renameError ? true : undefined}
                  autoComplete="off"
                  spellCheck={false}
                  className={clsx(
                    "inline-flex w-full items-center bg-transparent text-[13px] font-medium text-neutral-900 caret-neutral-600 transition-colors duration-200 pr-1",
                    "px-0 py-0 align-middle",
                    "placeholder:text-neutral-400 outline-none border-none focus-visible:outline-none focus-visible:ring-0 appearance-none",
                    "dark:text-neutral-100 dark:caret-neutral-200 dark:placeholder:text-neutral-500",
                    isRenamePending &&
                      "text-neutral-400/70 dark:text-neutral-500/70 cursor-wait"
                  )}
                />
              ) : (
                <span className="text-[13px] font-medium truncate min-w-0 pr-1">
                  {task.text}
                </span>
              )}
            </div>
            <div className="text-[11px] text-neutral-400 dark:text-neutral-500 min-w-0 text-right flex items-center justify-end gap-2">
              {task.environmentId && (
                <EnvironmentName
                  environmentId={task.environmentId}
                  teamSlugOrId={teamSlugOrId}
                />
              )}
              {(task.projectFullName ||
                (task.baseBranch && task.baseBranch !== "main")) && (
                <span>
                  {task.projectFullName && (
                    <span>{task.projectFullName.split("/")[1]}</span>
                  )}
                  {task.projectFullName &&
                    task.baseBranch &&
                    task.baseBranch !== "main" &&
                    "/"}
                  {task.baseBranch && task.baseBranch !== "main" && (
                    <span>{task.baseBranch}</span>
                  )}
                </span>
              )}
            </div>
            <div className="text-[11px] text-neutral-400 dark:text-neutral-500 flex-shrink-0 tabular-nums text-right">
              {task.updatedAt &&
                (() => {
                  const date = new Date(task.updatedAt);
                  const today = new Date();
                  const isToday =
                    date.getDate() === today.getDate() &&
                    date.getMonth() === today.getMonth() &&
                    date.getFullYear() === today.getFullYear();

                  return (
                    <span>
                      {isToday
                        ? date.toLocaleTimeString([], {
                            hour: "numeric",
                            minute: "2-digit",
                          })
                        : date.toLocaleDateString([], {
                            month: "short",
                            day: "numeric",
                          })}
                    </span>
                  );
                })()}
            </div>
          </Link>
        </ContextMenu.Trigger>
        {renameError && (
          <div className="mt-1 pl-[76px] pr-3 text-[11px] text-red-500 dark:text-red-400">
            {renameError}
          </div>
        )}
        <ContextMenu.Portal>
          <ContextMenu.Positioner className="outline-none z-[var(--z-context-menu)]">
            <ContextMenu.Popup className="origin-[var(--transform-origin)] rounded-md bg-white dark:bg-neutral-800 py-1 text-neutral-900 dark:text-neutral-100 shadow-lg shadow-gray-200 outline-1 outline-neutral-200 transition-[opacity] data-[ending-style]:opacity-0 dark:shadow-none dark:-outline-offset-1 dark:outline-neutral-700">
              <ContextMenu.Item
                className="flex items-center gap-2 cursor-default py-1.5 pr-8 pl-3 text-[13px] leading-5 outline-none select-none data-[highlighted]:relative data-[highlighted]:z-0 data-[highlighted]:text-white data-[highlighted]:before:absolute data-[highlighted]:before:inset-x-1 data-[highlighted]:before:inset-y-0 data-[highlighted]:before:z-[-1] data-[highlighted]:before:rounded-sm data-[highlighted]:before:bg-neutral-900 dark:data-[highlighted]:before:bg-neutral-700"
                onClick={handleCopyFromMenu}
              >
                <Copy className="w-3.5 h-3.5 text-neutral-600 dark:text-neutral-300" />
                <span>Copy description</span>
              </ContextMenu.Item>
              {canRename ? (
                <ContextMenu.Item
                  className="flex items-center gap-2 cursor-default py-1.5 pr-8 pl-3 text-[13px] leading-5 outline-none select-none data-[highlighted]:relative data-[highlighted]:z-0 data-[highlighted]:text-white data-[highlighted]:before:absolute data-[highlighted]:before:inset-x-1 data-[highlighted]:before:inset-y-0 data-[highlighted]:before:z-[-1] data-[highlighted]:before:rounded-sm data-[highlighted]:before:bg-neutral-900 dark:data-[highlighted]:before:bg-neutral-700"
                  onClick={handleStartRenaming}
                >
                  <Pencil className="w-3.5 h-3.5 text-neutral-600 dark:text-neutral-300" />
                  <span>Rename</span>
                </ContextMenu.Item>
              ) : null}
              {task.pinned ? (
                <ContextMenu.Item
                  className="flex items-center gap-2 cursor-default py-1.5 pr-8 pl-3 text-[13px] leading-5 outline-none select-none data-[highlighted]:relative data-[highlighted]:z-0 data-[highlighted]:text-white data-[highlighted]:before:absolute data-[highlighted]:before:inset-x-1 data-[highlighted]:before:inset-y-0 data-[highlighted]:before:z-[-1] data-[highlighted]:before:rounded-sm data-[highlighted]:before:bg-neutral-900 dark:data-[highlighted]:before:bg-neutral-700"
                  onClick={handleUnpinFromMenu}
                >
                  <PinOff className="w-3.5 h-3.5 text-neutral-600 dark:text-neutral-300" />
                  <span>Unpin</span>
                </ContextMenu.Item>
              ) : (
                <ContextMenu.Item
                  className="flex items-center gap-2 cursor-default py-1.5 pr-8 pl-3 text-[13px] leading-5 outline-none select-none data-[highlighted]:relative data-[highlighted]:z-0 data-[highlighted]:text-white data-[highlighted]:before:absolute data-[highlighted]:before:inset-x-1 data-[highlighted]:before:inset-y-0 data-[highlighted]:before:z-[-1] data-[highlighted]:before:rounded-sm data-[highlighted]:before:bg-neutral-900 dark:data-[highlighted]:before:bg-neutral-700"
                  onClick={handlePinFromMenu}
                >
                  <Pin className="w-3.5 h-3.5 text-neutral-600 dark:text-neutral-300" />
                  <span>Pin</span>
                </ContextMenu.Item>
              )}
              {task.isArchived ? (
                <ContextMenu.Item
                  className="flex items-center gap-2 cursor-default py-1.5 pr-8 pl-3 text-[13px] leading-5 outline-none select-none data-[highlighted]:relative data-[highlighted]:z-0 data-[highlighted]:text-white data-[highlighted]:before:absolute data-[highlighted]:before:inset-x-1 data-[highlighted]:before:inset-y-0 data-[highlighted]:before:z-[-1] data-[highlighted]:before:rounded-sm data-[highlighted]:before:bg-neutral-900 dark:data-[highlighted]:before:bg-neutral-700"
                  onClick={handleUnarchiveFromMenu}
                >
                  <ArchiveRestore className="w-3.5 h-3.5 text-neutral-600 dark:text-neutral-300" />
                  <span>Unarchive</span>
                </ContextMenu.Item>
              ) : (
                <ContextMenu.Item
                  className="flex items-center gap-2 cursor-default py-1.5 pr-8 pl-3 text-[13px] leading-5 outline-none select-none data-[highlighted]:relative data-[highlighted]:z-0 data-[highlighted]:text-white data-[highlighted]:before:absolute data-[highlighted]:before:inset-x-1 data-[highlighted]:before:inset-y-0 data-[highlighted]:before:z-[-1] data-[highlighted]:before:rounded-sm data-[highlighted]:before:bg-neutral-900 dark:data-[highlighted]:before:bg-neutral-700"
                  onClick={handleArchiveFromMenu}
                >
                  <Archive className="w-3.5 h-3.5 text-neutral-600 dark:text-neutral-300" />
                  <span>Archive</span>
                </ContextMenu.Item>
              )}
            </ContextMenu.Popup>
          </ContextMenu.Positioner>
        </ContextMenu.Portal>
      </ContextMenu.Root>
      <div className="right-2 top-0 bottom-0 absolute py-2 group">
        <div className="flex gap-1">
          {/* Copy button */}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={handleCopy}
                className={clsx(
                  "p-1 rounded",
                  "bg-neutral-100 dark:bg-neutral-700",
                  "text-neutral-600 dark:text-neutral-400",
                  "hover:bg-neutral-200 dark:hover:bg-neutral-600",
                  "group-hover:opacity-100 opacity-0"
                )}
                title="Copy task description"
              >
                {clipboard.copied ? (
                  <Check className="w-3.5 h-3.5" />
                ) : (
                  <Copy className="w-3.5 h-3.5" />
                )}
              </button>
            </TooltipTrigger>
            <TooltipContent side="top">
              {clipboard.copied ? "Copied!" : "Copy description"}
            </TooltipContent>
          </Tooltip>

          {/* Open with dropdown - always appears on hover */}
          <OpenWithDropdown
            vscodeUrl={vscodeUrl}
            vscodeProvider={vscodeProvider}
            worktreePath={runWithVSCode?.worktreePath || task.worktreePath}
            branch={task.baseBranch}
            className="group-hover:opacity-100 aria-expanded:opacity-100 opacity-0"
          />

          {/* Keep-alive button */}
          {runWithVSCode && hasActiveVSCode && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={handleToggleKeepAlive}
                  className={clsx(
                    "p-1 rounded",
                    "bg-neutral-100 dark:bg-neutral-700",
                    runWithVSCode.vscode?.keepAlive
                      ? "text-blue-600 dark:text-blue-400"
                      : "text-neutral-600 dark:text-neutral-400",
                    "hover:bg-neutral-200 dark:hover:bg-neutral-600",
                    "group-hover:opacity-100 opacity-0",
                    "hidden" // TODO: show this button
                  )}
                >
                  <Pin className="w-3.5 h-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="top">
                {runWithVSCode.vscode?.keepAlive
                  ? "Container will stay running"
                  : "Keep container running"}
              </TooltipContent>
            </Tooltip>
          )}

          {/* Archive / Unarchive button with tooltip */}
          <Tooltip>
            <TooltipTrigger asChild>
              {task.isArchived ? (
                <button
                  onClick={handleUnarchive}
                  className={clsx(
                    "p-1 rounded",
                    "bg-neutral-100 dark:bg-neutral-700",
                    "text-neutral-600 dark:text-neutral-400",
                    "hover:bg-neutral-200 dark:hover:bg-neutral-600",
                    "group-hover:opacity-100 opacity-0"
                  )}
                  title="Unarchive task"
                >
                  <ArchiveRestore className="w-3.5 h-3.5" />
                </button>
              ) : (
                <button
                  onClick={handleArchive}
                  disabled={taskIsArchiving}
                  className={clsx(
                    "p-1 rounded",
                    "bg-neutral-100 dark:bg-neutral-700",
                    "text-neutral-600 dark:text-neutral-400",
                    "hover:bg-neutral-200 dark:hover:bg-neutral-600",
                    taskIsArchiving
                      ? "opacity-100"
                      : "group-hover:opacity-100 opacity-0",
                    taskIsArchiving && "cursor-not-allowed"
                  )}
                  title="Archive task"
                >
                  {taskIsArchiving ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Archive className="w-3.5 h-3.5" />
                  )}
                </button>
              )}
            </TooltipTrigger>
            <TooltipContent side="top">
              {taskIsArchiving
                ? "Archiving..."
                : task.isArchived
                  ? "Unarchive task"
                  : "Archive task"}
            </TooltipContent>
          </Tooltip>
        </div>
      </div>
    </div>
  );
});
