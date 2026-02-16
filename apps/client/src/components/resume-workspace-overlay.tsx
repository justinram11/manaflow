import { useCallback, useMemo } from "react";
import clsx from "clsx";
import { Button } from "@/components/ui/button";
import type { Doc } from "@cmux/convex/dataModel";
import {
  useMorphInstancePauseQuery,
  useResumeMorphWorkspace,
} from "@/hooks/useMorphWorkspace";
import {
  useFirecrackerPauseQuery,
  useResumeFirecrackerWorkspace,
} from "@/hooks/useFirecrackerWorkspace";
import { AlertTriangle } from "lucide-react";

/**
 * Detect if a task run is backed by Firecracker (new or legacy provider value).
 */
function isFirecrackerRun(taskRun: Doc<"taskRuns">): boolean {
  if (taskRun.vscode?.provider === "firecracker") return true;
  if (taskRun.vscode?.provider === "docker" && taskRun.vscode.containerName?.startsWith("fc-")) return true;
  return false;
}

interface ResumeWorkspaceOverlayProps {
  taskRun: Doc<"taskRuns">;
  teamSlugOrId: string;
  className?: string;
  onResumed?: () => void;
}

export function ResumeWorkspaceOverlay({
  taskRun,
  teamSlugOrId,
  className,
  onResumed,
}: ResumeWorkspaceOverlayProps) {
  const taskRunId = taskRun._id;
  const isFirecracker = useMemo(() => isFirecrackerRun(taskRun), [taskRun]);

  // Morph hooks (only enabled when not Firecracker)
  const morphPauseQuery = useMorphInstancePauseQuery({
    taskRunId,
    teamSlugOrId,
    enabled: !isFirecracker,
  });

  const morphResume = useResumeMorphWorkspace({
    taskRunId,
    teamSlugOrId,
    onSuccess: onResumed,
  });

  // Firecracker hooks (only enabled when Firecracker)
  const fcPauseQuery = useFirecrackerPauseQuery({
    taskRunId,
    teamSlugOrId,
    enabled: isFirecracker,
  });

  const fcResume = useResumeFirecrackerWorkspace({
    taskRunId,
    teamSlugOrId,
    onSuccess: onResumed,
  });

  // Unified state
  const pauseStatusQuery = isFirecracker ? fcPauseQuery : morphPauseQuery;
  const isPaused = pauseStatusQuery.data?.paused === true;
  const isStopped = !isFirecracker && (morphPauseQuery.data as { stopped?: boolean } | undefined)?.stopped === true;
  const isResuming = isFirecracker ? fcResume.isPending : morphResume.isPending;

  const handleResume = useCallback(async () => {
    if (!taskRun || !isPaused || isStopped) {
      return;
    }

    if (isFirecracker) {
      await fcResume.mutateAsync();
    } else {
      await morphResume.mutateAsync({
        path: { taskRunId },
        body: { teamSlugOrId },
      });
    }
  }, [fcResume, morphResume, isPaused, isStopped, isFirecracker, taskRun, taskRunId, teamSlugOrId]);

  if (!isPaused) {
    return null;
  }

  // Show different UI for permanently stopped instances
  if (isStopped) {
    return (
      <div
        className={clsx(
          "absolute inset-0 flex items-center justify-center bg-neutral-50/90 backdrop-blur-sm dark:bg-black/80",
          className
        )}
      >
        <div className="rounded-lg border border-neutral-200/80 bg-white/90 p-4 text-center shadow-sm dark:border-neutral-800 dark:bg-neutral-900/80 max-w-sm">
          <div className="flex justify-center mb-2">
            <AlertTriangle className="h-8 w-8 text-amber-500" />
          </div>
          <p className="text-sm font-medium text-neutral-900 dark:text-neutral-50">
            Workspace expired
          </p>
          <p className="mt-1 text-xs text-neutral-600 dark:text-neutral-400">
            This workspace was automatically cleaned up after being inactive for
            2 weeks. Your code changes are preserved in any commits or pull
            requests you created.
          </p>
          <p className="mt-2 text-xs text-neutral-500 dark:text-neutral-500">
            To continue working, create a new task with the same repository.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div
      className={clsx(
        "absolute inset-0 flex items-center justify-center bg-neutral-50/90 backdrop-blur-sm dark:bg-black/80",
        className
      )}
    >
      <div className="rounded-lg border border-neutral-200/80 bg-white/90 p-4 text-center shadow-sm dark:border-neutral-800 dark:bg-neutral-900/80">
        <p className="text-sm font-medium text-neutral-900 dark:text-neutral-50">
          Workspace paused
        </p>
        <p className="mt-1 text-xs text-neutral-600 dark:text-neutral-400">
          Resume your VM to reconnect VS Code.
        </p>
        <Button
          className="mt-3"
          onClick={handleResume}
          disabled={isResuming}
          variant="default"
        >
          {isResuming ? "Resuming…" : "Resume VM"}
        </Button>
      </div>
    </div>
  );
}
