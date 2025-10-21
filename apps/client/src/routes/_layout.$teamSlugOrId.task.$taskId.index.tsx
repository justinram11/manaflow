import { TaskRunChatPane } from "@/components/TaskRunChatPane";
import { TaskRunTerminalPane } from "@/components/TaskRunTerminalPane";
import { FloatingPane } from "@/components/floating-pane";
import { TaskDetailHeader } from "@/components/task-detail-header";
import type { PersistentIframeStatus } from "@/components/persistent-iframe";
import { PersistentWebView } from "@/components/persistent-webview";
import { WorkspaceLoadingIndicator } from "@/components/workspace-loading-indicator";
import { ResizableGrid } from "@/components/ResizableGrid";
import { TaskRunGitDiffPanel } from "@/components/TaskRunGitDiffPanel";
import { RenderPanel } from "@/components/TaskPanelFactory";
import { loadPanelConfig, savePanelConfig } from "@/lib/panel-config";
import type { PanelConfig } from "@/lib/panel-config";
import {
  getTaskRunBrowserPersistKey,
  getTaskRunPersistKey,
} from "@/lib/persistent-webview-keys";
import {
  toMorphVncUrl,
  toProxyWorkspaceUrl,
} from "@/lib/toProxyWorkspaceUrl";
import {
  TASK_RUN_IFRAME_ALLOW,
  TASK_RUN_IFRAME_SANDBOX,
  preloadTaskRunIframes,
} from "../lib/preloadTaskRunIframes";
import { api } from "@cmux/convex/api";
import type { Id } from "@cmux/convex/dataModel";
import { typedZid } from "@cmux/shared/utils/typed-zid";
import { convexQuery } from "@convex-dev/react-query";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import z from "zod";

type TaskRunListItem = (typeof api.taskRuns.getByTask._returnType)[number];
type IframeStatusEntry = {
  status: PersistentIframeStatus;
  url: string | null;
};

const paramsSchema = z.object({
  taskId: typedZid("tasks"),
});

export const Route = createFileRoute("/_layout/$teamSlugOrId/task/$taskId/")({
  component: TaskDetailPage,
  params: {
    parse: paramsSchema.parse,
    stringify: (params) => ({
      taskId: params.taskId,
    }),
  },
  validateSearch: (search: Record<string, unknown>) => {
    const runId = typedZid("taskRuns").optional().parse(search.runId);
    return {
      runId,
    };
  },
  loader: async (opts) => {
    await Promise.all([
      opts.context.queryClient.ensureQueryData(
        convexQuery(api.taskRuns.getByTask, {
          teamSlugOrId: opts.params.teamSlugOrId,
          taskId: opts.params.taskId,
        }),
      ),
      opts.context.queryClient.ensureQueryData(
        convexQuery(api.tasks.getById, {
          teamSlugOrId: opts.params.teamSlugOrId,
          id: opts.params.taskId,
        }),
      ),
      opts.context.queryClient.ensureQueryData(
        convexQuery(api.crown.getCrownEvaluation, {
          teamSlugOrId: opts.params.teamSlugOrId,
          taskId: opts.params.taskId,
        }),
      ),
    ]);
  },
});

function flattenRunsWithDepth(
  runs: TaskRunListItem[],
): Array<TaskRunListItem & { depth: number }> {
  const result: Array<TaskRunListItem & { depth: number }> = [];

  const traverse = (run: TaskRunListItem, depth: number) => {
    result.push({ ...run, depth });
    run.children?.forEach((child) => traverse(child, depth + 1));
  };

  runs.forEach((run) => traverse(run, 0));
  return result;
}

function findRunById(
  runs: TaskRunListItem[],
  runId: TaskRunListItem["_id"],
): TaskRunListItem | null {
  for (const run of runs) {
    if (run._id === runId) {
      return run;
    }
    const childMatch = run.children ? findRunById(run.children, runId) : null;
    if (childMatch) {
      return childMatch;
    }
  }
  return null;
}

function TaskDetailPage() {
  const { taskId, teamSlugOrId } = Route.useParams();
  const search = Route.useSearch();
  const { data: task } = useSuspenseQuery(
    convexQuery(api.tasks.getById, {
      teamSlugOrId,
      id: taskId,
    }),
  );
  const { data: taskRuns } = useSuspenseQuery(
    convexQuery(api.taskRuns.getByTask, {
      teamSlugOrId,
      taskId,
    }),
  );
  const { data: crownEvaluation } = useSuspenseQuery(
    convexQuery(api.crown.getCrownEvaluation, {
      teamSlugOrId,
      taskId,
    }),
  );

  const [panelConfig, setPanelConfig] = useState<PanelConfig>(() => loadPanelConfig());
  const [iframeStatusByKey, setIframeStatusByKey] = useState<Record<string, IframeStatusEntry>>({});

  const handlePanelSwap = useCallback((fromPosition: "topLeft" | "topRight" | "bottomLeft" | "bottomRight", toPosition: "topLeft" | "topRight" | "bottomLeft" | "bottomRight") => {
    setPanelConfig(prev => {
      const newConfig = { ...prev };
      const temp = newConfig[fromPosition];
      newConfig[fromPosition] = newConfig[toPosition];
      newConfig[toPosition] = temp;
      savePanelConfig(newConfig);
      return newConfig;
    });
    // Trigger resize event to help iframes reposition correctly
    setTimeout(() => {
      window.dispatchEvent(new Event('resize'));
    }, 50);
  }, []);

  const runsWithDepth = useMemo(
    () => flattenRunsWithDepth(taskRuns ?? []),
    [taskRuns],
  );

  const selectedRun = useMemo(() => {
    if (!taskRuns?.length) {
      return null;
    }
    const runFromSearch = search.runId
      ? findRunById(taskRuns, search.runId)
      : null;
    if (runFromSearch) {
      return runFromSearch;
    }
    return taskRuns[0];
  }, [search.runId, taskRuns]);

  const selectedRunId = selectedRun?._id ?? null;
  const headerTaskRunId = selectedRunId ?? taskRuns?.[0]?._id ?? null;

  const rawWorkspaceUrl = selectedRun?.vscode?.workspaceUrl ?? null;
  const workspaceUrl = rawWorkspaceUrl ? toProxyWorkspaceUrl(rawWorkspaceUrl) : null;
  const workspacePersistKey = selectedRunId
    ? getTaskRunPersistKey(selectedRunId)
    : null;

  useEffect(() => {
    if (selectedRunId && workspaceUrl) {
      void preloadTaskRunIframes([
        {
          url: workspaceUrl,
          taskRunId: selectedRunId,
        },
      ]);
    }
  }, [selectedRunId, workspaceUrl]);

  const updateIframeStatus = useCallback(
    (persistKey: string | null, url: string | null, status: PersistentIframeStatus) => {
      if (!persistKey) {
        return;
      }
      setIframeStatusByKey((prev) => {
        const current = prev[persistKey];
        if (current && current.status === status && current.url === url) {
          return prev;
        }
        if (current && current.status === "loaded" && status === "loading" && current.url === url) {
          return prev;
        }
        return {
          ...prev,
          [persistKey]: {
            status,
            url,
          },
        };
      });
    },
    [],
  );

  const handleWorkspaceStatusChange = useCallback(
    (status: PersistentIframeStatus) => {
      updateIframeStatus(workspacePersistKey, workspaceUrl, status);
    },
    [updateIframeStatus, workspacePersistKey, workspaceUrl],
  );

  const onEditorLoad = useCallback(() => {
    if (selectedRunId) {
      console.log(`Workspace view loaded for task run ${selectedRunId}`);
    }
  }, [selectedRunId]);

  const onEditorError = useCallback((error: Error) => {
    if (selectedRunId) {
      console.error(`Failed to load workspace view for task run ${selectedRunId}:`, error);
    }
  }, [selectedRunId]);

  const editorLoadingFallback = useMemo(
    () => <WorkspaceLoadingIndicator variant="vscode" status="loading" />,
    [],
  );
  const editorErrorFallback = useMemo(
    () => <WorkspaceLoadingIndicator variant="vscode" status="error" />,
    [],
  );

  const rawBrowserUrl = selectedRun?.vscode?.url ?? selectedRun?.vscode?.workspaceUrl ?? null;
  const browserUrl = useMemo(() => {
    if (!rawBrowserUrl) {
      return null;
    }
    return toMorphVncUrl(rawBrowserUrl);
  }, [rawBrowserUrl]);
  const browserPersistKey = selectedRunId
    ? getTaskRunBrowserPersistKey(selectedRunId)
    : null;
  const hasBrowserView = Boolean(browserUrl);
  const isMorphProvider = selectedRun?.vscode?.provider === "morph";

  const handleBrowserStatusChange = useCallback(
    (status: PersistentIframeStatus) => {
      updateIframeStatus(browserPersistKey, browserUrl, status);
    },
    [updateIframeStatus, browserPersistKey, browserUrl],
  );

  const browserOverlayMessage = useMemo(() => {
    if (!selectedRun) {
      return runsWithDepth.length
        ? "Select a run to open the browser preview."
        : "Run the task to expose a browser preview.";
    }
    if (!isMorphProvider) {
      return "Browser preview is only available for Morph workspaces.";
    }
    if (!hasBrowserView) {
      return "Waiting for the workspace to expose a browser session…";
    }
    return "Launching browser…";
  }, [selectedRun, runsWithDepth.length, isMorphProvider, hasBrowserView]);
  const editorStatus = workspacePersistKey
    ? iframeStatusByKey[workspacePersistKey]?.status ?? "loading"
    : "loading";
  const browserStatus = browserPersistKey
    ? iframeStatusByKey[browserPersistKey]?.status ?? "loading"
    : "loading";
  const isEditorBusy = Boolean(selectedRun) && (!workspaceUrl || editorStatus !== "loaded");
  const isBrowserBusy = Boolean(selectedRun) && (!hasBrowserView || browserStatus !== "loaded");

  const workspacePlaceholderMessage = useMemo(() => {
    if (!runsWithDepth.length) {
      return "Run the task to launch a workspace.";
    }
    if (!selectedRun) {
      return "Select a run to open the workspace.";
    }
    return "Workspace is starting…";
  }, [runsWithDepth.length, selectedRun]);

  const panelProps = useMemo(
    () => ({
      task: task ?? null,
      taskRuns: taskRuns ?? null,
      crownEvaluation,
      workspaceUrl,
      workspacePersistKey,
      selectedRun: selectedRun ?? null,
      editorStatus,
      setEditorStatus: handleWorkspaceStatusChange,
      onEditorLoad,
      onEditorError,
      editorLoadingFallback,
      editorErrorFallback,
      workspacePlaceholderMessage,
      isEditorBusy,
      rawWorkspaceUrl,
      browserUrl,
      browserPersistKey,
      browserStatus,
      setBrowserStatus: handleBrowserStatusChange,
      browserOverlayMessage,
      isMorphProvider,
      isBrowserBusy,
      TaskRunChatPane,
      PersistentWebView,
      WorkspaceLoadingIndicator,
      TaskRunTerminalPane,
      TaskRunGitDiffPanel,
      TASK_RUN_IFRAME_ALLOW,
      TASK_RUN_IFRAME_SANDBOX,
    }), [
      task,
      taskRuns,
      crownEvaluation,
      workspaceUrl,
      workspacePersistKey,
      selectedRun,
      editorStatus,
      handleWorkspaceStatusChange,
      onEditorLoad,
      onEditorError,
      editorLoadingFallback,
      editorErrorFallback,
      workspacePlaceholderMessage,
      isEditorBusy,
      rawWorkspaceUrl,
      browserUrl,
      browserPersistKey,
      browserStatus,
      handleBrowserStatusChange,
      browserOverlayMessage,
      isMorphProvider,
      isBrowserBusy,
    ],
  );

  return (
    <FloatingPane>
      <div className="flex h-full min-h-0 flex-col bg-neutral-50 dark:bg-black">
        <TaskDetailHeader
          task={task ?? null}
          taskRuns={taskRuns ?? null}
          selectedRun={selectedRun ?? null}
          taskRunId={headerTaskRunId ?? ("" as Id<"taskRuns">)}
          teamSlugOrId={teamSlugOrId}
        />
        <div className="flex flex-1 min-h-0 px-1 py-1">
          <ResizableGrid
            storageKey="taskDetailGrid"
            defaultLeftWidth={50}
            defaultTopHeight={50}
            topLeft={
              <RenderPanel key={`panel-${panelConfig.topLeft}`} {...panelProps} type={panelConfig.topLeft} position="topLeft" onSwap={handlePanelSwap} />
            }
            topRight={
              <RenderPanel key={`panel-${panelConfig.topRight}`} {...panelProps} type={panelConfig.topRight} position="topRight" onSwap={handlePanelSwap} />
            }
            bottomLeft={
              <RenderPanel key={`panel-${panelConfig.bottomLeft}`} {...panelProps} type={panelConfig.bottomLeft} position="bottomLeft" onSwap={handlePanelSwap} />
            }
            bottomRight={
              <RenderPanel key={`panel-${panelConfig.bottomRight}`} {...panelProps} type={panelConfig.bottomRight} position="bottomRight" onSwap={handlePanelSwap} />
            }
          />
        </div>
      </div>
    </FloatingPane>
  );
}
