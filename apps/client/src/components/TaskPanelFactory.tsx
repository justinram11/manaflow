import React, { useState, useEffect, useRef, type ReactNode, useCallback } from "react";
import { Code2, Globe2, TerminalSquare, GitCompare, GripVertical, X } from "lucide-react";
import clsx from "clsx";
import type { PanelType } from "@/lib/panel-config";
import { PANEL_LABELS } from "@/lib/panel-config";
import type { PersistentIframeStatus } from "@/components/persistent-iframe";
import type { Doc, Id } from "@cmux/convex/dataModel";
import type { TaskRunWithChildren } from "@/types/task";

type PanelPosition = "topLeft" | "topRight" | "bottomLeft" | "bottomRight";

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
  const dragOverTimeoutRef = useRef<number | null>(null);
  const isDraggingRef = useRef(false);
  const restoreTimeoutRef = useRef<number | null>(null);

  // Restore iframe pointer events helper - with force flag to always restore
  const restoreIframePointerEvents = useCallback((force = false) => {
    const iframes = Array.from(document.querySelectorAll("iframe"));
    for (const el of iframes) {
      if (el instanceof HTMLIFrameElement) {
        if (force) {
          // Force remove pointer-events restriction
          el.style.removeProperty("pointer-events");
          delete el.dataset.prevPointerEvents;
        } else {
          const prev = el.dataset.prevPointerEvents;
          if (prev !== undefined) {
            if (prev === "__unset__") el.style.removeProperty("pointer-events");
            else el.style.pointerEvents = prev;
            delete el.dataset.prevPointerEvents;
          }
        }
      }
    }
  }, []);

  // Cleanup drag state on unmount or when drag is abandoned
  useEffect(() => {
    const handleGlobalDragEnd = () => {
      if (isDraggingRef.current) {
        restoreIframePointerEvents();
        isDraggingRef.current = false;

        // Clear any existing restore timeout
        if (restoreTimeoutRef.current !== null) {
          window.clearTimeout(restoreTimeoutRef.current);
          restoreTimeoutRef.current = null;
        }
      }
    };

    // Listen for global drag end events to ensure cleanup
    window.addEventListener("dragend", handleGlobalDragEnd);
    window.addEventListener("drop", handleGlobalDragEnd);

    return () => {
      window.removeEventListener("dragend", handleGlobalDragEnd);
      window.removeEventListener("drop", handleGlobalDragEnd);
      if (dragOverTimeoutRef.current !== null) {
        window.clearTimeout(dragOverTimeoutRef.current);
      }
      if (restoreTimeoutRef.current !== null) {
        window.clearTimeout(restoreTimeoutRef.current);
      }
      if (isDraggingRef.current) {
        restoreIframePointerEvents(true); // Force restore on unmount
      }
    };
  }, [restoreIframePointerEvents]);

  const handleDragStart = (e: React.DragEvent) => {
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", position);
    if (e.currentTarget instanceof HTMLElement) {
      e.currentTarget.style.opacity = "0.5";
    }

    isDraggingRef.current = true;

    // Disable pointer events on iframes while dragging to prevent interference
    const iframes = Array.from(document.querySelectorAll("iframe"));
    for (const el of iframes) {
      if (el instanceof HTMLIFrameElement) {
        const current = el.style.pointerEvents;
        el.dataset.prevPointerEvents = current ? current : "__unset__";
        el.style.pointerEvents = "none";
      }
    }

    // Failsafe: force restore pointer events after 5 seconds in case drag end events fail
    restoreTimeoutRef.current = window.setTimeout(() => {
      if (isDraggingRef.current) {
        console.warn("Drag operation timeout - forcing iframe pointer-events restore");
        restoreIframePointerEvents(true);
        isDraggingRef.current = false;
      }
      restoreTimeoutRef.current = null;
    }, 5000);
  };

  const handleDragEnd = (e: React.DragEvent) => {
    if (e.currentTarget instanceof HTMLElement) {
      e.currentTarget.style.opacity = "1";
    }
    // Ensure drag over state is cleared when drag ends
    setIsDragOver(false);
    if (dragOverTimeoutRef.current !== null) {
      window.clearTimeout(dragOverTimeoutRef.current);
      dragOverTimeoutRef.current = null;
    }
    if (restoreTimeoutRef.current !== null) {
      window.clearTimeout(restoreTimeoutRef.current);
      restoreTimeoutRef.current = null;
    }

    isDraggingRef.current = false;
    restoreIframePointerEvents();
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";

    // Only update state if it's not already true to prevent unnecessary re-renders
    setIsDragOver(prev => {
      if (!prev) {
        return true;
      }
      return prev;
    });

    // Clear any existing timeout
    if (dragOverTimeoutRef.current !== null) {
      window.clearTimeout(dragOverTimeoutRef.current);
    }

    // Auto-clear drag over state if drag events stop (in case dragLeave is missed)
    dragOverTimeoutRef.current = window.setTimeout(() => {
      setIsDragOver(false);
      dragOverTimeoutRef.current = null;
    }, 100);
  };

  const handleDragLeave = () => {
    // Clear timeout if it exists
    if (dragOverTimeoutRef.current !== null) {
      window.clearTimeout(dragOverTimeoutRef.current);
      dragOverTimeoutRef.current = null;
    }
    setIsDragOver(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();

    // Clear timeout
    if (dragOverTimeoutRef.current !== null) {
      window.clearTimeout(dragOverTimeoutRef.current);
      dragOverTimeoutRef.current = null;
    }

    setIsDragOver(false);
    const fromPosition = e.dataTransfer.getData("text/plain") as PanelPosition;
    if (fromPosition !== position && onSwap) {
      onSwap(fromPosition, position);
    }
  };

  const panelWrapper = (icon: ReactNode, title: string, content: ReactNode) => (
    <div
      className={clsx(
        "flex h-full flex-col overflow-hidden rounded-lg border bg-white shadow-sm dark:bg-neutral-950 transition-all duration-150",
        isDragOver
          ? "border-blue-500 dark:border-blue-400 ring-2 ring-blue-500/30 dark:ring-blue-400/30"
          : "border-neutral-200 dark:border-neutral-800"
      )}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div className="flex items-center gap-1.5 border-b border-neutral-200 px-2 py-1 dark:border-neutral-800">
        <div
          draggable
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
          className="flex flex-1 items-center gap-1.5 cursor-move group transition-opacity"
        >
          <GripVertical className="size-3.5 text-neutral-400 dark:text-neutral-500 group-hover:text-neutral-600 dark:group-hover:text-neutral-300 transition-colors" />
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
            className="flex items-center justify-center size-5 rounded hover:bg-neutral-100 dark:hover:bg-neutral-800 text-neutral-500 hover:text-neutral-700 dark:text-neutral-400 dark:hover:text-neutral-200 transition-colors"
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
            "flex h-full flex-col overflow-hidden rounded-lg border bg-white shadow-sm dark:bg-neutral-950 transition-all duration-150",
            isDragOver
              ? "border-blue-500 dark:border-blue-400 ring-2 ring-blue-500/30 dark:ring-blue-400/30"
              : "border-neutral-200 dark:border-neutral-800"
          )}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          <TaskRunChatPane
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
          <TaskRunTerminalPane workspaceUrl={rawWorkspaceUrl} />
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
          <TaskRunGitDiffPanel task={task} selectedRun={selectedRun} />
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
      prevProps.browserUrl !== nextProps.browserUrl) {
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
