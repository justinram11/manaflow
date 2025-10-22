import React, { useState, useEffect, type ReactNode, useCallback } from "react";
import { Code2, Globe2, TerminalSquare, GitCompare, GripVertical, X } from "lucide-react";
import clsx from "clsx";
import type { PanelType } from "@/lib/panel-config";
import { PANEL_LABELS } from "@/lib/panel-config";
import type { PersistentIframeStatus } from "@/components/persistent-iframe";
import type { Doc, Id } from "@cmux/convex/dataModel";
import type { TaskRunWithChildren } from "@/types/task";

type PanelPosition = "topLeft" | "topRight" | "bottomLeft" | "bottomRight";

const PANEL_DRAG_START_EVENT = "cmux:panel-drag-start";
const PANEL_DRAG_END_EVENT = "cmux:panel-drag-end";
type PanelDragLifecycleEvent = typeof PANEL_DRAG_START_EVENT | typeof PANEL_DRAG_END_EVENT;

const dispatchPanelDragEvent = (event: PanelDragLifecycleEvent) => {
  if (typeof window === "undefined") {
    return;
  }
  window.dispatchEvent(new Event(event));
};

interface PanelFactoryProps {
  type: PanelType | null;
  position: PanelPosition;
  onSwap?: (fromPosition: PanelPosition, toPosition: PanelPosition) => void;
  onClose?: (position: PanelPosition) => void;
  // Chat panel props
  task?: Doc<"tasks"> | null;
  taskRuns?: TaskRunWithChildren[] | null;
  crownEvaluation?: {
    evaluatedAt?: number;
    winnerRunId?: Id<"taskRuns">;
    reason?: string;
  } | null;
  // Workspace panel props
  workspaceUrl?: string | null;
  workspacePersistKey?: string | null;
  selectedRun?: TaskRunWithChildren | null;
  editorStatus?: PersistentIframeStatus;
  setEditorStatus?: (status: PersistentIframeStatus) => void;
  onEditorLoad?: () => void;
  onEditorError?: (error: Error) => void;
  editorLoadingFallback?: ReactNode;
  editorErrorFallback?: ReactNode;
  workspacePlaceholderMessage?: string;
  isEditorBusy?: boolean;
  // Terminal panel props
  rawWorkspaceUrl?: string | null;
  // Browser panel props
  browserUrl?: string | null;
  browserPersistKey?: string | null;
  browserStatus?: PersistentIframeStatus;
  setBrowserStatus?: (status: PersistentIframeStatus) => void;
  browserOverlayMessage?: string;
  isMorphProvider?: boolean;
  isBrowserBusy?: boolean;
  // Additional components
  /* eslint-disable @typescript-eslint/no-explicit-any */
  TaskRunChatPane?: React.ComponentType<any>;
  PersistentWebView?: React.ComponentType<any>;
  WorkspaceLoadingIndicator?: React.ComponentType<any>;
  TaskRunTerminalPane?: React.ComponentType<any>;
  TaskRunGitDiffPanel?: React.ComponentType<any>;
  /* eslint-enable @typescript-eslint/no-explicit-any */
  // Constants
  TASK_RUN_IFRAME_ALLOW?: string;
  TASK_RUN_IFRAME_SANDBOX?: string;
}

const RenderPanelComponent = (props: PanelFactoryProps): ReactNode => {
  const { type, position, onSwap, onClose } = props;
  const [isDragOver, setIsDragOver] = useState(false);
  const [isDraggingSelf, setIsDraggingSelf] = useState(false);
  const [isPanelDragActive, setIsPanelDragActive] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const handleStart = () => {
      setIsPanelDragActive(true);
    };
    const handleEnd = () => {
      setIsPanelDragActive(false);
      setIsDragOver(false);
    };

    window.addEventListener(PANEL_DRAG_START_EVENT, handleStart);
    window.addEventListener(PANEL_DRAG_END_EVENT, handleEnd);

    return () => {
      window.removeEventListener(PANEL_DRAG_START_EVENT, handleStart);
      window.removeEventListener(PANEL_DRAG_END_EVENT, handleEnd);
    };
  }, []);

  const handleDragStart = useCallback((e: React.DragEvent) => {
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", position);
    setIsDraggingSelf(true);
    dispatchPanelDragEvent(PANEL_DRAG_START_EVENT);
  }, [position]);

  const handleDragEnd = useCallback(() => {
    setIsDraggingSelf(false);
    setIsDragOver(false);
    dispatchPanelDragEvent(PANEL_DRAG_END_EVENT);
  }, []);

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(true);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    const nextTarget = e.relatedTarget as Node | null;
    if (nextTarget && e.currentTarget.contains(nextTarget)) {
      return;
    }
    setIsDragOver(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    const fromPosition = e.dataTransfer.getData("text/plain") as PanelPosition;
    if (fromPosition && fromPosition !== position && onSwap) {
      onSwap(fromPosition, position);
    }
    dispatchPanelDragEvent(PANEL_DRAG_END_EVENT);
  }, [onSwap, position]);

  const showDropOverlay = isPanelDragActive && !isDraggingSelf;

  const renderDropOverlay = () => {
    if (!showDropOverlay) {
      return null;
    }

    return (
      <div
        aria-hidden
        className={clsx(
          "pointer-events-auto absolute inset-0 z-10 rounded-lg",
          isDragOver ? "bg-blue-500/10 dark:bg-blue-400/15" : "bg-transparent"
        )}
        onDragEnter={(event) => {
          handleDragEnter(event);
          event.stopPropagation();
        }}
        onDragOver={(event) => {
          handleDragOver(event);
          event.stopPropagation();
        }}
        onDragLeave={(event) => {
          handleDragLeave(event);
          event.stopPropagation();
        }}
        onDrop={(event) => {
          handleDrop(event);
          event.stopPropagation();
        }}
      />
    );
  };

  const panelWrapper = (icon: ReactNode, title: string, content: ReactNode) => (
    <div
      className={clsx(
        "relative flex h-full flex-col overflow-hidden rounded-lg border bg-white shadow-sm transition-all duration-150 dark:bg-neutral-950",
        isDragOver
          ? "border-blue-500 dark:border-blue-400 ring-2 ring-blue-500/30 dark:ring-blue-400/30"
          : "border-neutral-200 dark:border-neutral-800"
      )}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {renderDropOverlay()}
      <div className="flex items-center gap-1.5 border-b border-neutral-200 px-2 py-1 dark:border-neutral-800">
        <div
          draggable
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
          className={clsx(
            "flex flex-1 items-center gap-1.5 cursor-move group transition-opacity",
            isDraggingSelf && "opacity-60"
          )}
        >
          <GripVertical className="size-3.5 text-neutral-400 transition-colors group-hover:text-neutral-600 dark:text-neutral-500 dark:group-hover:text-neutral-300" />
          <div className="flex size-5 items-center justify-center rounded-full bg-neutral-200 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-200">
            {icon}
          </div>
          <h2 className="text-xs font-medium text-neutral-800 dark:text-neutral-100">
            {title}
          </h2>
        </div>
        {onClose && (
          <button
            type="button"
            onClick={() => onClose(position)}
            className="flex size-5 items-center justify-center rounded text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-700 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
            title="Close panel"
          >
            <X className="size-3.5" />
          </button>
        )}
      </div>
      {content}
    </div>
  );

  switch (type) {
    case "chat": {
      const { task, taskRuns, crownEvaluation, TaskRunChatPane } = props;
      if (!TaskRunChatPane) return null;
      return (
        <div
          className={clsx(
            "relative flex h-full flex-col overflow-hidden rounded-lg border bg-white shadow-sm transition-all duration-150 dark:bg-neutral-950",
            isDragOver
              ? "border-blue-500 dark:border-blue-400 ring-2 ring-blue-500/30 dark:ring-blue-400/30"
              : "border-neutral-200 dark:border-neutral-800"
          )}
          onDragEnter={handleDragEnter}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          {renderDropOverlay()}
          <TaskRunChatPane
            key={task?._id}
            task={task}
            taskRuns={taskRuns}
            crownEvaluation={crownEvaluation}
            hideHeader={false}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
            onClose={onClose ? () => onClose(position) : undefined}
            position={position}
          />
        </div>
      );
    }

    case "workspace": {
      const {
        workspaceUrl,
        workspacePersistKey,
        selectedRun,
        setEditorStatus,
        onEditorLoad,
        onEditorError,
        editorLoadingFallback,
        editorErrorFallback,
        workspacePlaceholderMessage,
        isEditorBusy,
        PersistentWebView,
        WorkspaceLoadingIndicator,
        TASK_RUN_IFRAME_ALLOW,
        TASK_RUN_IFRAME_SANDBOX,
      } = props;

      if (!PersistentWebView || !WorkspaceLoadingIndicator) return null;
      const shouldShowWorkspaceLoader = Boolean(selectedRun) && !workspaceUrl;

      return panelWrapper(
        <Code2 className="size-3" aria-hidden />,
        PANEL_LABELS.workspace,
        <div className="relative flex-1" aria-busy={isEditorBusy}>
          {workspaceUrl && workspacePersistKey ? (
            <PersistentWebView
              key={workspacePersistKey}
              persistKey={workspacePersistKey}
              src={workspaceUrl}
              className="flex h-full"
              iframeClassName="select-none"
              allow={TASK_RUN_IFRAME_ALLOW}
              sandbox={TASK_RUN_IFRAME_SANDBOX}
              retainOnUnmount
              suspended={!selectedRun}
              onLoad={onEditorLoad}
              onError={onEditorError}
              fallback={editorLoadingFallback}
              fallbackClassName="bg-neutral-50 dark:bg-black"
              errorFallback={editorErrorFallback}
              errorFallbackClassName="bg-neutral-50/95 dark:bg-black/95"
              onStatusChange={setEditorStatus}
              loadTimeoutMs={60_000}
            />
          ) : shouldShowWorkspaceLoader ? (
            <div className="flex h-full items-center justify-center">
              <WorkspaceLoadingIndicator variant="vscode" status="loading" />
            </div>
          ) : (
            <div className="flex h-full items-center justify-center px-4 text-center text-sm text-neutral-500 dark:text-neutral-400">
              {workspacePlaceholderMessage}
            </div>
          )}
        </div>
      );
    }

    case "terminal": {
      const { rawWorkspaceUrl, TaskRunTerminalPane } = props;
      if (!TaskRunTerminalPane) return null;

      return panelWrapper(
        <TerminalSquare className="size-3" aria-hidden />,
        PANEL_LABELS.terminal,
        <div className="flex-1 bg-black">
          <TaskRunTerminalPane key={rawWorkspaceUrl} workspaceUrl={rawWorkspaceUrl} />
        </div>
      );
    }

    case "browser": {
      const {
        browserUrl,
        browserPersistKey,
        setBrowserStatus,
        browserOverlayMessage,
        selectedRun,
        isMorphProvider,
        isBrowserBusy,
        PersistentWebView,
        WorkspaceLoadingIndicator,
        TASK_RUN_IFRAME_ALLOW,
        TASK_RUN_IFRAME_SANDBOX,
      } = props;

      if (!PersistentWebView || !WorkspaceLoadingIndicator) return null;
      const shouldShowBrowserLoader = Boolean(selectedRun) && isMorphProvider && (!browserUrl || !browserPersistKey);

      return panelWrapper(
        <Globe2 className="size-3" aria-hidden />,
        PANEL_LABELS.browser,
        <div className="relative flex-1" aria-busy={isBrowserBusy}>
          {browserUrl && browserPersistKey ? (
            <PersistentWebView
              key={browserPersistKey}
              persistKey={browserPersistKey}
              src={browserUrl}
              className="flex h-full"
              iframeClassName="select-none"
              allow={TASK_RUN_IFRAME_ALLOW}
              sandbox={TASK_RUN_IFRAME_SANDBOX}
              retainOnUnmount
              onStatusChange={setBrowserStatus}
              fallback={
                <WorkspaceLoadingIndicator variant="browser" status="loading" />
              }
              fallbackClassName="bg-neutral-50 dark:bg-black"
              errorFallback={
                <WorkspaceLoadingIndicator variant="browser" status="error" />
              }
              errorFallbackClassName="bg-neutral-50/95 dark:bg-black/95"
              loadTimeoutMs={45_000}
            />
          ) : shouldShowBrowserLoader ? (
            <div className="flex h-full items-center justify-center">
              <WorkspaceLoadingIndicator variant="browser" status="loading" />
            </div>
          ) : (
            <div className="flex h-full items-center justify-center px-4 text-center text-sm text-neutral-500 dark:text-neutral-400">
              {browserOverlayMessage}
            </div>
          )}
        </div>
      );
    }

    case "gitDiff": {
      const { task, selectedRun, TaskRunGitDiffPanel } = props;
      if (!TaskRunGitDiffPanel) return null;

      return panelWrapper(
        <GitCompare className="size-3" aria-hidden />,
        PANEL_LABELS.gitDiff,
        <div className="flex-1 overflow-auto">
          <TaskRunGitDiffPanel key={selectedRun?._id} task={task} selectedRun={selectedRun} />
        </div>
      );
    }

    case null:
      return null;

    default:
      return null;
  }
};

// Memoize to prevent unnecessary re-renders during drag operations
// Only re-render when critical props actually change
export const RenderPanel = React.memo(RenderPanelComponent, (prevProps, nextProps) => {
  // Always re-render if type or position changes
  if (prevProps.type !== nextProps.type || prevProps.position !== nextProps.position) {
    return false;
  }

  // For iframe-based panels (workspace/browser), check persist keys
  if (prevProps.type === "workspace" || prevProps.type === "browser") {
    if (prevProps.workspacePersistKey !== nextProps.workspacePersistKey ||
      prevProps.browserPersistKey !== nextProps.browserPersistKey ||
      prevProps.workspaceUrl !== nextProps.workspaceUrl ||
      prevProps.browserUrl !== nextProps.browserUrl ||
      prevProps.selectedRun?._id !== nextProps.selectedRun?._id) {
      return false;
    }
  }

  // For terminal panel, check workspace URL
  if (prevProps.type === "terminal") {
    if (prevProps.rawWorkspaceUrl !== nextProps.rawWorkspaceUrl) {
      return false;
    }
  }

  // For chat panel, check task and run changes
  if (prevProps.type === "chat") {
    if (prevProps.task?._id !== nextProps.task?._id ||
      prevProps.taskRuns !== nextProps.taskRuns ||
      prevProps.crownEvaluation !== nextProps.crownEvaluation) {
      return false;
    }
  }

  // For gitDiff panel, check task and selectedRun changes
  if (prevProps.type === "gitDiff") {
    if (prevProps.task?._id !== nextProps.task?._id ||
      prevProps.selectedRun?._id !== nextProps.selectedRun?._id) {
      return false;
    }
  }

  // Check if callbacks changed (using reference equality)
  if (prevProps.onSwap !== nextProps.onSwap || prevProps.onClose !== nextProps.onClose) {
    return false;
  }

  // If we got here, props are effectively the same - skip re-render
  return true;
});
