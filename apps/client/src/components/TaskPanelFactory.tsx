import React, { useState, type ReactNode } from "react";
import { Code2, Globe2, TerminalSquare, GitCompare, GripVertical } from "lucide-react";
import clsx from "clsx";
import type { PanelType } from "@/lib/panel-config";
import { PANEL_LABELS } from "@/lib/panel-config";
import type { PersistentIframeStatus } from "@/components/persistent-iframe";
import type { Doc, Id } from "@cmux/convex/dataModel";
import type { TaskRunWithChildren } from "@/types/task";

type PanelPosition = "topLeft" | "topRight" | "bottomLeft" | "bottomRight";

interface PanelFactoryProps {
  type: PanelType;
  position: PanelPosition;
  onSwap?: (fromPosition: PanelPosition, toPosition: PanelPosition) => void;
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

export function RenderPanel(props: PanelFactoryProps): ReactNode {
  const { type, position, onSwap } = props;
  const [isDragOver, setIsDragOver] = useState(false);

  const handleDragStart = (e: React.DragEvent) => {
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", position);
    if (e.currentTarget instanceof HTMLElement) {
      e.currentTarget.style.opacity = "0.5";
    }
  };

  const handleDragEnd = (e: React.DragEvent) => {
    if (e.currentTarget instanceof HTMLElement) {
      e.currentTarget.style.opacity = "1";
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setIsDragOver(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    // Only clear if we're actually leaving the container (not entering a child)
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const x = e.clientX;
    const y = e.clientY;

    if (
      x < rect.left ||
      x >= rect.right ||
      y < rect.top ||
      y >= rect.bottom
    ) {
      setIsDragOver(false);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
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
      <div
        draggable
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        className="flex items-center gap-1.5 border-b border-neutral-200 px-2 py-1 dark:border-neutral-800 cursor-move group transition-opacity"
      >
        <GripVertical className="size-3.5 text-neutral-400 dark:text-neutral-500 group-hover:text-neutral-600 dark:group-hover:text-neutral-300 transition-colors" />
        <div className="flex size-5 items-center justify-center rounded-full bg-neutral-200 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-200">
          {icon}
        </div>
        <h2 className="text-xs font-medium text-neutral-800 dark:text-neutral-100">
          {title}
        </h2>
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

      return panelWrapper(
        <Code2 className="size-3" aria-hidden />,
        PANEL_LABELS.workspace,
        <div className="relative flex-1" aria-busy={isEditorBusy}>
          {workspaceUrl && workspacePersistKey ? (
            <PersistentWebView
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
          ) : (
            <div className="flex h-full items-center justify-center px-4 text-center text-sm text-neutral-500 dark:text-neutral-400">
              {workspacePlaceholderMessage}
            </div>
          )}
          {selectedRun && !workspaceUrl ? (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <WorkspaceLoadingIndicator variant="vscode" status="loading" />
            </div>
          ) : null}
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

      return panelWrapper(
        <Globe2 className="size-3" aria-hidden />,
        PANEL_LABELS.browser,
        <div className="relative flex-1" aria-busy={isBrowserBusy}>
          {browserUrl && browserPersistKey ? (
            <PersistentWebView
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
          ) : (
            <div className="flex h-full items-center justify-center px-4 text-center text-sm text-neutral-500 dark:text-neutral-400">
              {browserOverlayMessage}
            </div>
          )}
          {selectedRun && isMorphProvider ? (
            <div
              className={clsx(
                "pointer-events-none absolute inset-0 flex items-center justify-center transition-opacity",
                {
                  "opacity-100": isBrowserBusy,
                  "opacity-0": !isBrowserBusy,
                },
              )}
            >
              <WorkspaceLoadingIndicator variant="browser" status="loading" />
            </div>
          ) : null}
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

    default:
      return null;
  }
}
