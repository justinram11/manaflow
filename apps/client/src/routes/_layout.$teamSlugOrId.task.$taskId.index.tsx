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
import { loadPanelConfig, savePanelConfig, getAvailablePanels, PANEL_LABELS } from "@/lib/panel-config";
import type { PanelConfig, PanelType } from "@/lib/panel-config";
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
import { typedZid } from "@cmux/shared/utils/typed-zid";
import { convexQuery } from "@convex-dev/react-query";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Plus, Code2, Globe2, TerminalSquare, GitCompare, MessageCircle } from "lucide-react";
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

interface EmptyPanelSlotProps {
  position: "topLeft" | "topRight" | "bottomLeft" | "bottomRight";
  availablePanels: PanelType[];
  onAddPanel: (position: "topLeft" | "topRight" | "bottomLeft" | "bottomRight", panelType: PanelType) => void;
}

function EmptyPanelSlot({ position, availablePanels, onAddPanel }: EmptyPanelSlotProps) {
  const [isOpen, setIsOpen] = useState(false);

  const getPanelIcon = (panelType: PanelType) => {
    switch (panelType) {
      case "chat":
        return <MessageCircle className="size-4" />;
      case "workspace":
        return <Code2 className="size-4" />;
      case "terminal":
        return <TerminalSquare className="size-4" />;
      case "browser":
        return <Globe2 className="size-4" />;
      case "gitDiff":
        return <GitCompare className="size-4" />;
    }
  };

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-lg border border-dashed border-neutral-300 bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-900">
      <div className="flex h-full items-center justify-center p-4">
        {availablePanels.length > 0 ? (
          <div className="relative">
            <button
              type="button"
              onClick={() => setIsOpen(!isOpen)}
              className="flex items-center gap-2 rounded-lg border border-neutral-300 bg-white px-4 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-50 dark:border-neutral-600 dark:bg-neutral-800 dark:text-neutral-200 dark:hover:bg-neutral-700 transition-colors"
            >
              <Plus className="size-4" />
              Add Panel
            </button>
            {isOpen && (
              <>
                <div
                  className="fixed inset-0 z-10"
                  onClick={() => setIsOpen(false)}
                />
                <div className="absolute left-0 top-full z-20 mt-2 w-48 rounded-lg border border-neutral-200 bg-white shadow-lg dark:border-neutral-700 dark:bg-neutral-800">
                  {availablePanels.map((panelType) => (
                    <button
                      key={panelType}
                      type="button"
                      onClick={() => {
                        onAddPanel(position, panelType);
                        setIsOpen(false);
                      }}
                      className="flex w-full items-center gap-3 px-4 py-2 text-left text-sm text-neutral-700 hover:bg-neutral-100 dark:text-neutral-200 dark:hover:bg-neutral-700 first:rounded-t-lg last:rounded-b-lg transition-colors"
                    >
                      <div className="flex size-5 items-center justify-center rounded-full bg-neutral-200 text-neutral-700 dark:bg-neutral-700 dark:text-neutral-200">
                        {getPanelIcon(panelType)}
                      </div>
                      {PANEL_LABELS[panelType]}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        ) : (
          <p className="text-sm text-neutral-500 dark:text-neutral-400">
            All panels are in use
          </p>
        )}
      </div>
    </div>
  );
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
    // Use startTransition to mark this as a non-urgent update
    // This helps React keep the UI stable during the swap
    setPanelConfig(prev => {
      const newConfig = { ...prev };
      const temp = newConfig[fromPosition];
      newConfig[fromPosition] = newConfig[toPosition];
      newConfig[toPosition] = temp;
      savePanelConfig(newConfig);
      return newConfig;
    });

    // Trigger resize events after React completes the swap
    // Multiple RAF calls ensure all layout recalculations are done
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        window.dispatchEvent(new Event('resize'));
        // Third RAF to ensure iframes have repositioned
        requestAnimationFrame(() => {
          window.dispatchEvent(new Event('resize'));
        });
      });
    });
  }, []);

  const handlePanelClose = useCallback((position: "topLeft" | "topRight" | "bottomLeft" | "bottomRight") => {
    setPanelConfig(prev => {
      const newConfig = { ...prev };
      newConfig[position] = null;
      savePanelConfig(newConfig);
      return newConfig;
    });
    // Trigger resize event to help iframes reposition correctly
    // Use requestAnimationFrame to ensure React has finished re-rendering
    requestAnimationFrame(() => {
      window.dispatchEvent(new Event('resize'));
      // Double RAF to ensure layout is complete
      requestAnimationFrame(() => {
        window.dispatchEvent(new Event('resize'));
      });
    });
  }, []);

  const handleAddPanel = useCallback((position: "topLeft" | "topRight" | "bottomLeft" | "bottomRight", panelType: PanelType) => {
    setPanelConfig(prev => {
      const newConfig = { ...prev };
      newConfig[position] = panelType;
      savePanelConfig(newConfig);
      return newConfig;
    });
    // Trigger resize event to help iframes reposition correctly
    // Use requestAnimationFrame to ensure React has finished re-rendering
    requestAnimationFrame(() => {
      window.dispatchEvent(new Event('resize'));
      // Double RAF to ensure layout is complete
      requestAnimationFrame(() => {
        window.dispatchEvent(new Event('resize'));
      });
    });
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
        : "Browser preview becomes available once a run starts.";
    }
    if (!isMorphProvider) {
      return "Browser preview is loading. Note that browser preview is only supported in cloud mode.";
    }
    if (!hasBrowserView) {
      return "Waiting for the workspace to expose a browser preview...";
    }
    return "Launching browser preview...";
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
      return "Waiting for a run to start the workspace...";
    }
    if (!selectedRun) {
      return "Select a run to open the workspace.";
    }
    return "Workspace is starting...";
  }, [runsWithDepth.length, selectedRun]);

  const availablePanels = useMemo(() => getAvailablePanels(panelConfig), [panelConfig]);

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
      onClose: handlePanelClose,
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
    handlePanelClose,
  ],
  );

  return (
    <FloatingPane>
      <div className="flex h-full min-h-0 flex-col bg-neutral-50 dark:bg-black">
        <TaskDetailHeader
          task={task}
          taskRuns={taskRuns}
          selectedRun={selectedRun}
          taskRunId={headerTaskRunId}
          teamSlugOrId={teamSlugOrId}
        />
        <div className="flex flex-1 min-h-0 px-1 py-1">
          <ResizableGrid
            storageKey="taskDetailGrid"
            defaultLeftWidth={50}
            defaultTopHeight={50}
            topLeft={
              panelConfig.topLeft ? (
                <RenderPanel key={panelConfig.topLeft} {...panelProps} type={panelConfig.topLeft} position="topLeft" onSwap={handlePanelSwap} />
              ) : (
                <EmptyPanelSlot position="topLeft" availablePanels={availablePanels} onAddPanel={handleAddPanel} />
              )
            }
            topRight={
              panelConfig.topRight ? (
                <RenderPanel key={panelConfig.topRight} {...panelProps} type={panelConfig.topRight} position="topRight" onSwap={handlePanelSwap} />
              ) : (
                <EmptyPanelSlot position="topRight" availablePanels={availablePanels} onAddPanel={handleAddPanel} />
              )
            }
            bottomLeft={
              panelConfig.bottomLeft ? (
                <RenderPanel key={panelConfig.bottomLeft} {...panelProps} type={panelConfig.bottomLeft} position="bottomLeft" onSwap={handlePanelSwap} />
              ) : (
                <EmptyPanelSlot position="bottomLeft" availablePanels={availablePanels} onAddPanel={handleAddPanel} />
              )
            }
            bottomRight={
              panelConfig.bottomRight ? (
                <RenderPanel key={panelConfig.bottomRight} {...panelProps} type={panelConfig.bottomRight} position="bottomRight" onSwap={handlePanelSwap} />
              ) : (
                <EmptyPanelSlot position="bottomRight" availablePanels={availablePanels} onAddPanel={handleAddPanel} />
              )
            }
          />
        </div>
      </div>
    </FloatingPane>
  );
}
