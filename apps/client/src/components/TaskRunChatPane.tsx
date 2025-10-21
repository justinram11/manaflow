import { TaskTimeline } from "@/components/task-timeline";
import type { Doc, Id } from "@cmux/convex/dataModel";
import type { TaskRunWithChildren } from "@/types/task";
import clsx from "clsx";
import { MessageCircle, GripVertical } from "lucide-react";

interface TaskRunChatPaneProps {
  task: Doc<"tasks"> | null | undefined;
  taskRuns: TaskRunWithChildren[] | null | undefined;
  crownEvaluation?: {
    evaluatedAt?: number;
    winnerRunId?: Id<"taskRuns">;
    reason?: string;
  } | null;
  hideHeader?: boolean;
  className?: string;
  onDragStart?: (e: React.DragEvent) => void;
  onDragEnd?: (e: React.DragEvent) => void;
}

export function TaskRunChatPane({
  task,
  taskRuns,
  crownEvaluation,
  hideHeader = false,
  className,
  onDragStart,
  onDragEnd,
}: TaskRunChatPaneProps) {
  return (
    <div className={clsx("flex h-full flex-col", className)}>
      {hideHeader ? null : (
        <div
          draggable={Boolean(onDragStart)}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          className={clsx(
            "flex items-center gap-1.5 border-b border-neutral-200 px-2 py-1 dark:border-neutral-800 transition-opacity",
            onDragStart && "cursor-move group"
          )}
        >
          {onDragStart && (
            <GripVertical className="size-3.5 text-neutral-400 dark:text-neutral-500 group-hover:text-neutral-600 dark:group-hover:text-neutral-300 transition-colors" />
          )}
          <div className="flex size-5 items-center justify-center rounded-full bg-neutral-200 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-200">
            <MessageCircle className="size-3" aria-hidden />
          </div>
          <h2 className="text-xs font-medium text-neutral-800 dark:text-neutral-100">
            Chat &amp; Activity
          </h2>
        </div>
      )}
      <div className="flex-1 overflow-y-auto px-3 py-2">
        {taskRuns ? (
          <TaskTimeline
            task={task ?? null}
            taskRuns={taskRuns}
            crownEvaluation={crownEvaluation ?? null}
          />
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-neutral-500 dark:text-neutral-400">
            Loading conversation…
          </div>
        )}
      </div>
    </div>
  );
}
