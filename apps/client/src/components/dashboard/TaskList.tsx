import type { DbTask } from "@cmux/www-openapi-client";
import {
  getApiTasksOptions,
  getApiTasksPinnedOptions,
} from "@cmux/www-openapi-client/react-query";
import { useLocalStorage } from "@mantine/hooks";
import { useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { memo, useCallback, useMemo, useRef, useState } from "react";
import { TaskItem } from "./TaskItem";
import { PreviewItem } from "./PreviewItem";
import { ChevronRight } from "lucide-react";
import { env } from "../../client-env";

type TaskCategoryKey =
  | "pinned"
  | "workspaces"
  | "ready_to_review"
  | "in_progress"
  | "merged";

const CATEGORY_ORDER: TaskCategoryKey[] = [
  "pinned",
  "workspaces",
  "ready_to_review",
  "in_progress",
  "merged",
];

const CATEGORY_META: Record<
  TaskCategoryKey,
  { title: string; emptyLabel: string }
> = {
  pinned: {
    title: "Pinned",
    emptyLabel: "No pinned items.",
  },
  workspaces: {
    title: "Workspaces",
    emptyLabel: "No workspace sessions yet.",
  },
  ready_to_review: {
    title: "Ready to review",
    emptyLabel: "Nothing is waiting for review.",
  },
  in_progress: {
    title: "In progress",
    emptyLabel: "No tasks are currently in progress.",
  },
  merged: {
    title: "Merged",
    emptyLabel: "No merged tasks yet.",
  },
};

const createEmptyCategoryBuckets = (): Record<
  TaskCategoryKey,
  DbTask[]
> => ({
  pinned: [],
  workspaces: [],
  ready_to_review: [],
  in_progress: [],
  merged: [],
});

const getTaskCategory = (task: DbTask): TaskCategoryKey => {
  if (task.isCloudWorkspace || task.isLocalWorkspace) {
    return "workspaces";
  }
  if (task.mergeStatus === "pr_merged") {
    return "merged";
  }
  if ((task as Record<string, unknown>).crownEvaluationStatus === "succeeded") {
    return "ready_to_review";
  }
  return "in_progress";
};

const sortByRecentUpdate = (tasks: DbTask[]): DbTask[] => {
  if (tasks.length <= 1) {
    return tasks;
  }
  return [...tasks].sort(
    (a, b) =>
      (b.updatedAt ?? b.createdAt ?? 0) - (a.updatedAt ?? a.createdAt ?? 0)
  );
};

const categorizeTasks = (
  tasks: DbTask[] | undefined
): Record<TaskCategoryKey, DbTask[]> | null => {
  if (!tasks) {
    return null;
  }
  const buckets = createEmptyCategoryBuckets();
  for (const task of tasks) {
    const key = getTaskCategory(task);
    buckets[key].push(task);
  }
  for (const key of CATEGORY_ORDER) {
    buckets[key] = sortByRecentUpdate(buckets[key]);
  }
  return buckets;
};

const createCollapsedCategoryState = (
  defaultValue = false
): Record<TaskCategoryKey, boolean> => ({
  pinned: defaultValue,
  workspaces: defaultValue,
  ready_to_review: defaultValue,
  in_progress: defaultValue,
  merged: defaultValue,
});

// Preview run types
type PreviewRunWithConfig = {
  id: string;
  status: string;
  prNumber: number;
  repoFullName: string;
  prUrl: string;
  headRef?: string | null;
  completedAt?: number | null;
  startedAt?: number | null;
  createdAt?: number | null;
  configRepoFullName?: string;
  taskId?: string;
  taskRunId?: string;
};

type PreviewCategoryKey = "in_progress" | "completed";

const PREVIEW_CATEGORY_ORDER: PreviewCategoryKey[] = ["in_progress", "completed"];

const PREVIEW_CATEGORY_META: Record<
  PreviewCategoryKey,
  { title: string; emptyLabel: string }
> = {
  in_progress: {
    title: "In Progress",
    emptyLabel: "No previews are currently in progress.",
  },
  completed: {
    title: "Completed",
    emptyLabel: "No completed previews yet.",
  },
};

const createEmptyPreviewCategoryBuckets = (): Record<
  PreviewCategoryKey,
  PreviewRunWithConfig[]
> => ({
  in_progress: [],
  completed: [],
});

const getPreviewCategory = (run: PreviewRunWithConfig): PreviewCategoryKey | null => {
  if (run.status === "pending" || run.status === "running") {
    return "in_progress";
  }
  // Only "completed" and "skipped" should show as completed (green circles)
  if (run.status === "completed" || run.status === "skipped") {
    return "completed";
  }
  // "failed" runs are excluded from both categories
  return null;
};

const categorizePreviewRuns = (
  runs: PreviewRunWithConfig[] | undefined
): Record<PreviewCategoryKey, PreviewRunWithConfig[]> | null => {
  if (!runs) {
    return null;
  }
  const buckets = createEmptyPreviewCategoryBuckets();
  for (const run of runs) {
    const key = getPreviewCategory(run);
    // Skip runs that don't belong to any category (e.g., failed runs)
    if (key !== null) {
      buckets[key].push(run);
    }
  }
  return buckets;
};

const createCollapsedPreviewCategoryState = (
  defaultValue = false
): Record<PreviewCategoryKey, boolean> => ({
  in_progress: defaultValue,
  completed: defaultValue,
});

// Page sizes removed -- pagination not yet available in HTTP API

export const TaskList = memo(function TaskList({
  teamSlugOrId,
}: {
  teamSlugOrId: string;
}) {
  // In web mode, exclude local workspaces from the task list
  const excludeLocalWorkspaces = env.NEXT_PUBLIC_WEB_MODE ? "true" as const : undefined;

  const allTasksQuery = useQuery(
    getApiTasksOptions({ query: { teamSlugOrId, excludeLocalWorkspaces } }),
  );
  const allTasks = allTasksQuery.data?.tasks;

  const archivedTasksQuery = useQuery(
    getApiTasksOptions({ query: { teamSlugOrId, archived: "true", excludeLocalWorkspaces } }),
  );
  const archivedTasks = archivedTasksQuery.data?.tasks ?? [];
  const archivedStatus = archivedTasksQuery.isLoading
    ? "LoadingFirstPage" as const
    : "Exhausted" as const;

  const pinnedQuery = useQuery(
    getApiTasksPinnedOptions({ query: { teamSlugOrId, excludeLocalWorkspaces } }),
  );
  const pinnedData = pinnedQuery.data?.tasks;

  // Preview runs - for now use empty array since the paginated endpoint is not yet migrated
  const previewRuns: PreviewRunWithConfig[] = useMemo(() => [], []);

  const [tab, setTab] = useState<"all" | "archived" | "previews">("all");

  // Infinite scroll for archived tasks
  const archivedScrollRef = useRef<HTMLDivElement>(null);
  const loadMoreTriggerRef = useRef<HTMLDivElement>(null);
  // Infinite scroll for preview runs
  const previewScrollRef = useRef<HTMLDivElement>(null);
  const previewLoadMoreTriggerRef = useRef<HTMLDivElement>(null);

  // Note: Infinite scroll for archived and preview runs is not yet supported
  // with the HTTP API. All results are returned at once.

  const categorizedTasks = useMemo(() => {
    const categorized = categorizeTasks(allTasks);
    if (categorized && pinnedData) {
      // Filter pinned tasks out from other categories
      const pinnedTaskIds = new Set(pinnedData.map(t => t.id));

      for (const key of CATEGORY_ORDER) {
        if (key !== 'pinned') {
          categorized[key] = categorized[key].filter(t => !pinnedTaskIds.has(t.id));
        }
      }

      // Add pinned tasks to the pinned category (already sorted by the API)
      categorized.pinned = pinnedData;
    }
    return categorized;
  }, [allTasks, pinnedData]);
  const categoryBuckets = categorizedTasks ?? createEmptyCategoryBuckets();
  const collapsedStorageKey = useMemo(
    () => `dashboard-collapsed-categories-${teamSlugOrId}`,
    [teamSlugOrId]
  );
  const defaultCollapsedState = useMemo(
    () => createCollapsedCategoryState(),
    []
  );
  const [collapsedCategories, setCollapsedCategories] = useLocalStorage<
    Record<TaskCategoryKey, boolean>
  >({
    key: collapsedStorageKey,
    defaultValue: defaultCollapsedState,
    getInitialValueInEffect: true,
  });

  const toggleCategoryCollapse = useCallback((categoryKey: TaskCategoryKey) => {
    setCollapsedCategories((prev) => ({
      ...prev,
      [categoryKey]: !prev[categoryKey],
    }));
  }, [setCollapsedCategories]);

  // Preview runs categorization
  const categorizedPreviewRuns = useMemo(
    () => categorizePreviewRuns(previewRuns),
    [previewRuns]
  );
  const previewCategoryBuckets = categorizedPreviewRuns ?? createEmptyPreviewCategoryBuckets();

  const collapsedPreviewStorageKey = useMemo(
    () => `dashboard-collapsed-preview-categories-${teamSlugOrId}`,
    [teamSlugOrId]
  );
  const defaultCollapsedPreviewState = useMemo(
    () => createCollapsedPreviewCategoryState(),
    []
  );
  const [collapsedPreviewCategories, setCollapsedPreviewCategories] = useLocalStorage<
    Record<PreviewCategoryKey, boolean>
  >({
    key: collapsedPreviewStorageKey,
    defaultValue: defaultCollapsedPreviewState,
    getInitialValueInEffect: true,
  });

  const togglePreviewCategoryCollapse = useCallback((categoryKey: PreviewCategoryKey) => {
    setCollapsedPreviewCategories((prev) => ({
      ...prev,
      [categoryKey]: !prev[categoryKey],
    }));
  }, [setCollapsedPreviewCategories]);

  return (
    <div className="mt-6 w-full">
      <div className="mb-3 px-4">
        <div className="flex items-end gap-2.5 select-none">
          <button
            className={
              "text-sm font-medium transition-colors " +
              (tab === "all"
                ? "text-neutral-900 dark:text-neutral-100"
                : "text-neutral-500 dark:text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200")
            }
            onMouseDown={() => setTab("all")}
            onClick={() => setTab("all")}
          >
            Tasks
          </button>
          <button
            className={
              "text-sm font-medium transition-colors " +
              (tab === "previews"
                ? "text-neutral-900 dark:text-neutral-100"
                : "text-neutral-500 dark:text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200")
            }
            onMouseDown={() => setTab("previews")}
            onClick={() => setTab("previews")}
          >
            Previews
          </button>
          <button
            className={
              "text-sm font-medium transition-colors " +
              (tab === "archived"
                ? "text-neutral-900 dark:text-neutral-100"
                : "text-neutral-500 dark:text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200")
            }
            onMouseDown={() => setTab("archived")}
            onClick={() => setTab("archived")}
          >
            Archived
          </button>
        </div>
      </div>
      <div className="flex flex-col gap-1 w-full">
        {tab === "archived" ? (
          archivedStatus === "LoadingFirstPage" ? (
            <div className="text-sm text-neutral-500 dark:text-neutral-400 py-2 pl-4 select-none">
              Loading...
            </div>
          ) : archivedTasks.length === 0 ? (
            <div className="text-sm text-neutral-500 dark:text-neutral-400 py-2 pl-4 select-none">
              No archived tasks
            </div>
          ) : (
            <div ref={archivedScrollRef} className="flex flex-col w-full">
              {archivedTasks.map((task) => (
                <TaskItem
                  key={task.id}
                  task={task}
                  teamSlugOrId={teamSlugOrId}
                />
              ))}
              {/* Infinite scroll trigger (pagination not yet available in HTTP API) */}
              <div ref={loadMoreTriggerRef} className="w-full py-2" />
            </div>
          )
        ) : tab === "previews" ? (
          previewRuns.length === 0 ? (
            <div className="text-sm text-neutral-500 dark:text-neutral-400 py-2 pl-4 select-none">
              No preview runs
            </div>
          ) : (
            <div ref={previewScrollRef} className="flex flex-col w-full">
              <div className="mt-1 w-full flex flex-col space-y-[-1px] transform -translate-y-px">
                {PREVIEW_CATEGORY_ORDER.map((categoryKey) => (
                  <PreviewCategorySection
                    key={categoryKey}
                    categoryKey={categoryKey}
                    previewRuns={previewCategoryBuckets[categoryKey]}
                    teamSlugOrId={teamSlugOrId}
                    collapsed={Boolean(collapsedPreviewCategories[categoryKey])}
                    onToggle={togglePreviewCategoryCollapse}
                  />
                ))}
              </div>
              {/* Infinite scroll trigger (pagination not yet available in HTTP API) */}
              <div ref={previewLoadMoreTriggerRef} className="w-full py-2" />
            </div>
          )
        ) : allTasks === undefined ? (
          <div className="text-sm text-neutral-500 dark:text-neutral-400 py-2 pl-4 select-none">
            Loading...
          </div>
        ) : (
          <div className="mt-1 w-full flex flex-col space-y-[-1px] transform -translate-y-px">
            {CATEGORY_ORDER.map((categoryKey) => {
              // Don't render the pinned category if it's empty
              if (categoryKey === 'pinned' && categoryBuckets[categoryKey].length === 0) {
                return null;
              }
              return (
                <TaskCategorySection
                  key={categoryKey}
                  categoryKey={categoryKey}
                  tasks={categoryBuckets[categoryKey]}
                  teamSlugOrId={teamSlugOrId}
                  collapsed={Boolean(collapsedCategories[categoryKey])}
                  onToggle={toggleCategoryCollapse}
                />
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
});

function TaskCategorySection({
  categoryKey,
  tasks,
  teamSlugOrId,
  collapsed,
  onToggle,
}: {
  categoryKey: TaskCategoryKey;
  tasks: DbTask[];
  teamSlugOrId: string;
  collapsed: boolean;
  onToggle: (key: TaskCategoryKey) => void;
}) {
  const meta = CATEGORY_META[categoryKey];
  const handleToggle = useCallback(
    () => onToggle(categoryKey),
    [categoryKey, onToggle]
  );
  const contentId = `task-category-${categoryKey}`;
  const toggleLabel = collapsed
    ? `Expand ${meta.title}`
    : `Collapse ${meta.title}`;
  return (
    <div className="w-full">
      <div
        className="sticky top-0 z-10 flex w-full border-y border-neutral-200 dark:border-neutral-900 bg-neutral-100 dark:bg-neutral-800 select-none"
        onDoubleClick={handleToggle}
      >
        <div className="flex w-full items-center pr-4">
          <button
            type="button"
            onClick={handleToggle}
            aria-label={toggleLabel}
            aria-expanded={!collapsed}
            aria-controls={contentId}
            className="flex h-9 w-9 items-center justify-center text-neutral-500 hover:text-black dark:text-neutral-400 dark:hover:text-neutral-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-300 dark:focus-visible:outline-neutral-700 transition-colors"
          >
            <ChevronRight
              className={clsx(
                "h-3 w-3 transition-transform duration-200",
                !collapsed && "rotate-90"
              )}
              aria-hidden="true"
            />
          </button>
          <div className="flex items-center gap-2 text-xs font-medium tracking-tight text-neutral-900 dark:text-neutral-100">
            <span>{meta.title}</span>
            <span className="text-xs text-neutral-500 dark:text-neutral-400">
              {tasks.length}
            </span>
          </div>
        </div>
      </div>
      {collapsed ? null : tasks.length > 0 ? (
        <div id={contentId} className="flex flex-col w-full">
          {tasks.map((task) => (
            <TaskItem key={task.id} task={task} teamSlugOrId={teamSlugOrId} />
          ))}
        </div>
      ) : (
        <div className="flex w-full items-center px-4 py-3">
          <p className="pl-5 text-xs text-neutral-500 dark:text-neutral-400 select-none">
            {meta.emptyLabel}
          </p>
        </div>
      )}
    </div>
  );
}

function PreviewCategorySection({
  categoryKey,
  previewRuns,
  teamSlugOrId,
  collapsed,
  onToggle,
}: {
  categoryKey: PreviewCategoryKey;
  previewRuns: PreviewRunWithConfig[];
  teamSlugOrId: string;
  collapsed: boolean;
  onToggle: (key: PreviewCategoryKey) => void;
}) {
  const meta = PREVIEW_CATEGORY_META[categoryKey];
  const handleToggle = useCallback(
    () => onToggle(categoryKey),
    [categoryKey, onToggle]
  );
  const contentId = `preview-category-${categoryKey}`;
  const toggleLabel = collapsed
    ? `Expand ${meta.title}`
    : `Collapse ${meta.title}`;
  return (
    <div className="w-full">
      <div
        className="sticky top-0 z-10 flex w-full border-y border-neutral-200 dark:border-neutral-900 bg-neutral-100 dark:bg-neutral-800 select-none"
        onDoubleClick={handleToggle}
      >
        <div className="flex w-full items-center pr-4">
          <button
            type="button"
            onClick={handleToggle}
            aria-label={toggleLabel}
            aria-expanded={!collapsed}
            aria-controls={contentId}
            className="flex h-9 w-9 items-center justify-center text-neutral-500 hover:text-black dark:text-neutral-400 dark:hover:text-neutral-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-300 dark:focus-visible:outline-neutral-700 transition-colors"
          >
            <ChevronRight
              className={clsx(
                "h-3 w-3 transition-transform duration-200",
                !collapsed && "rotate-90"
              )}
              aria-hidden="true"
            />
          </button>
          <div className="flex items-center gap-2 text-xs font-medium tracking-tight text-neutral-900 dark:text-neutral-100">
            <span>{meta.title}</span>
            <span className="text-xs text-neutral-500 dark:text-neutral-400">
              {previewRuns.length}
            </span>
          </div>
        </div>
      </div>
      {collapsed ? null : previewRuns.length > 0 ? (
        <div id={contentId} className="flex flex-col w-full">
          {previewRuns.map((run) => (
            <PreviewItem key={run.id} previewRun={run} teamSlugOrId={teamSlugOrId} />
          ))}
        </div>
      ) : (
        <div className="flex w-full items-center px-4 py-3">
          <p className="pl-5 text-xs text-neutral-500 dark:text-neutral-400 select-none">
            {meta.emptyLabel}
          </p>
        </div>
      )}
    </div>
  );
}
