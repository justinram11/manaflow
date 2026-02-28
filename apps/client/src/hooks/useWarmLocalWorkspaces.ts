import { useEffect, useMemo, useRef } from "react";
import { useQueries } from "@tanstack/react-query";
import {
  getApiTaskRunsOptions,
} from "@cmux/www-openapi-client/react-query";
import type { DbTask } from "@cmux/www-openapi-client";
import { isFakeConvexId } from "@/lib/fakeConvexId";
import { useLocalVSCodeServeWebQuery } from "@/queries/local-vscode-serve-web";
import { getWorkspaceUrl } from "@/lib/workspace-url";
import {
  preloadTaskRunIframes,
  setTaskRunIframePinned,
} from "@/lib/preloadTaskRunIframes";

type TaskWithUnread = DbTask & { hasUnread?: boolean };

// Task run type from the API (generic record)
type TaskRunRecord = Record<string, unknown> & {
  id: string;
  isArchived?: boolean;
  vscode?: {
    provider?: string;
    status?: string;
    workspaceUrl?: string;
  };
  children?: TaskRunRecord[];
};

type WarmTarget = {
  taskRunId: string;
  url: string;
  pinned: boolean;
};

const MAX_ACTIVE_LOCAL_WARMUPS = 2;
const MAX_WARM_LOCAL_WORKSPACES = 10;

export function useWarmLocalWorkspaces({
  teamSlugOrId: _teamSlugOrId,
  tasks,
  pinnedTasks,
  enabled = true,
}: {
  teamSlugOrId: string;
  tasks: TaskWithUnread[] | undefined;
  pinnedTasks: TaskWithUnread[] | undefined;
  enabled?: boolean;
}) {
  const localServeWeb = useLocalVSCodeServeWebQuery();

  const pinnedLocalTasks = useMemo(() => {
    return (pinnedTasks ?? []).filter((task) => task.isLocalWorkspace);
  }, [pinnedTasks]);

  const pinnedTaskIds = useMemo(() => {
    return new Set(pinnedLocalTasks.map((task) => task.id));
  }, [pinnedLocalTasks]);

  const activeLocalTasks = useMemo(() => {
    return (tasks ?? []).filter(
      (task) => task.isLocalWorkspace && !pinnedTaskIds.has(task.id)
    );
  }, [tasks, pinnedTaskIds]);

  const warmCandidateTasks = useMemo(() => {
    if (!enabled) {
      return [];
    }

    const candidates: TaskWithUnread[] = [];
    const seen = new Set<string>();

    const addTask = (task: TaskWithUnread) => {
      if (isFakeConvexId(task.id)) {
        return;
      }
      if (seen.has(task.id)) {
        return;
      }
      if (candidates.length >= MAX_WARM_LOCAL_WORKSPACES) {
        return;
      }
      seen.add(task.id);
      candidates.push(task);
    };

    for (const task of pinnedLocalTasks) {
      addTask(task);
    }

    let activeCount = 0;
    for (const task of activeLocalTasks) {
      if (activeCount >= MAX_ACTIVE_LOCAL_WARMUPS) {
        break;
      }
      addTask(task);
      activeCount += 1;
    }

    return candidates;
  }, [activeLocalTasks, enabled, pinnedLocalTasks]);

  const taskRunQueryConfigs = useMemo(() => {
    if (!enabled) {
      return [];
    }

    return warmCandidateTasks
      .filter((task) => !isFakeConvexId(task.id))
      .map((task) => ({
        ...getApiTaskRunsOptions({ query: { taskId: task.id } }),
        // Tag with taskId so we can look up results by task
        meta: { taskId: task.id },
      }));
  }, [enabled, warmCandidateTasks]);

  const taskRunResults = useQueries({
    queries: taskRunQueryConfigs,
  });

  // Build a map of taskId -> task runs for lookup
  const taskRunsByTaskId = useMemo(() => {
    const map = new Map<string, TaskRunRecord[]>();
    for (let i = 0; i < taskRunQueryConfigs.length; i++) {
      const config = taskRunQueryConfigs[i];
      const result = taskRunResults[i];
      const taskId = config?.meta?.taskId;
      if (taskId && result?.data) {
        const data = result.data as { taskRuns?: TaskRunRecord[] };
        map.set(taskId as string, data.taskRuns ?? []);
      }
    }
    return map;
  }, [taskRunQueryConfigs, taskRunResults]);

  const warmTargets = useMemo<WarmTarget[]>(() => {
    if (!enabled) {
      return [];
    }

    const baseUrl = localServeWeb.data?.baseUrl;
    if (!baseUrl) {
      return [];
    }

    const targets: WarmTarget[] = [];

    for (const task of warmCandidateTasks) {
      const taskRuns = taskRunsByTaskId.get(task.id);
      if (!taskRuns || taskRuns.length === 0) {
        continue;
      }

      const flattened = flattenRuns(taskRuns);
      const localRun = selectLocalWorkspaceRun(flattened);
      if (!localRun) {
        continue;
      }

      if (localRun.vscode?.provider !== "other") {
        continue;
      }

      if (localRun.vscode?.status !== "running") {
        continue;
      }

      const workspaceUrl = getWorkspaceUrl(
        localRun.vscode?.workspaceUrl,
        localRun.vscode?.provider,
        baseUrl
      );
      if (!workspaceUrl) {
        continue;
      }

      targets.push({
        taskRunId: localRun.id,
        url: workspaceUrl,
        pinned: pinnedTaskIds.has(task.id),
      });
    }

    return targets;
  }, [
    enabled,
    localServeWeb.data?.baseUrl,
    pinnedTaskIds,
    taskRunsByTaskId,
    warmCandidateTasks,
  ]);

  const pinnedRunIds = useMemo(
    () =>
      warmTargets
        .filter((target) => target.pinned)
        .map((target) => target.taskRunId),
    [warmTargets]
  );

  const previousPinnedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!enabled) {
      if (previousPinnedRef.current.size > 0) {
        for (const runId of previousPinnedRef.current) {
          setTaskRunIframePinned(runId, false);
        }
        previousPinnedRef.current = new Set();
      }
      return;
    }

    const nextPinned = new Set(pinnedRunIds);
    const prevPinned = previousPinnedRef.current;

    for (const runId of nextPinned) {
      if (!prevPinned.has(runId)) {
        setTaskRunIframePinned(runId, true);
      }
    }

    for (const runId of prevPinned) {
      if (!nextPinned.has(runId)) {
        setTaskRunIframePinned(runId, false);
      }
    }

    previousPinnedRef.current = nextPinned;
  }, [enabled, pinnedRunIds]);

  useEffect(() => {
    if (!enabled) {
      return;
    }
    if (warmTargets.length === 0) {
      return;
    }
    void preloadTaskRunIframes(
      warmTargets.map(({ taskRunId, url }) => ({ taskRunId, url }))
    ).catch((error) => {
      console.error("Failed to warm local workspace iframes", error);
    });
  }, [enabled, warmTargets]);
}

function flattenRuns(runs: TaskRunRecord[]): TaskRunRecord[] {
  const acc: TaskRunRecord[] = [];
  const stack = [...runs];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }
    acc.push(current);
    if (current.children?.length) {
      stack.push(...current.children);
    }
  }

  return acc;
}

function selectLocalWorkspaceRun(
  runs: TaskRunRecord[]
): TaskRunRecord | null {
  const active = runs.find(
    (run) => !run.isArchived && run.vscode?.provider === "other"
  );
  if (active) {
    return active;
  }

  return runs.find((run) => run.vscode?.provider === "other") ?? null;
}
