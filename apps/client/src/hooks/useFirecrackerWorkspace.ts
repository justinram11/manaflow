import { useMutation, useQuery } from "@tanstack/react-query";
import { useQuery as useConvexQuery } from "convex/react";
import { api } from "@cmux/convex/api";
import type { Id } from "@cmux/convex/dataModel";
import { toast } from "sonner";
import { queryClient } from "@/query-client";

interface FirecrackerWorkspaceQueryArgs {
  taskRunId: Id<"taskRuns">;
  teamSlugOrId: string;
  enabled?: boolean;
}

interface UseResumeFirecrackerWorkspaceArgs {
  taskRunId: Id<"taskRuns">;
  teamSlugOrId: string;
  onSuccess?: () => void;
  onError?: (error: unknown) => void;
}

export function firecrackerPauseQueryKey(taskRunId: string, teamSlugOrId: string) {
  return ["firecracker", "task-run", taskRunId, "paused", teamSlugOrId] as const;
}

/**
 * Check whether a task run is backed by Firecracker.
 * Handles both the new "firecracker" provider and legacy "docker" with fc- prefix.
 */
function isFirecrackerProvider(provider?: string, containerName?: string): boolean {
  if (provider === "firecracker") return true;
  if (provider === "docker" && containerName?.startsWith("fc-")) return true;
  return false;
}

export function useFirecrackerPauseQuery({
  taskRunId,
  teamSlugOrId,
  enabled,
}: FirecrackerWorkspaceQueryArgs) {
  const taskRun = useConvexQuery(api.taskRuns.get, {
    teamSlugOrId,
    id: taskRunId,
  });
  const canQuery = isFirecrackerProvider(
    taskRun?.vscode?.provider,
    taskRun?.vscode?.containerName ?? undefined,
  );

  return useQuery({
    enabled: canQuery && enabled !== false,
    queryKey: firecrackerPauseQueryKey(taskRunId, teamSlugOrId),
    queryFn: async ({ signal }) => {
      const res = await fetch(
        `/api/sandboxes/firecracker/task-runs/${encodeURIComponent(taskRunId)}/is-paused`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ teamSlugOrId }),
          signal,
        },
      );
      if (!res.ok) {
        return { paused: false };
      }
      return (await res.json()) as { paused: boolean };
    },
  });
}

export function useFirecrackerPause({
  taskRunId,
  teamSlugOrId,
}: {
  taskRunId: Id<"taskRuns">;
  teamSlugOrId: string;
}) {
  const taskRun = useConvexQuery(api.taskRuns.get, {
    teamSlugOrId,
    id: taskRunId,
  });

  return useMutation<{ paused: true }, Error, void, { toastId: string | number }>({
    mutationKey: ["firecracker", "pause", taskRunId],
    mutationFn: async () => {
      const containerName = taskRun?.vscode?.containerName;
      if (!containerName) throw new Error("No VM found");

      const res = await fetch(
        `/api/sandboxes/firecracker/${encodeURIComponent(containerName)}/pause`,
        { method: "POST" },
      );
      if (!res.ok) {
        throw new Error(`Failed to pause VM: ${res.status}`);
      }
      return (await res.json()) as { paused: true };
    },
    onMutate: () => {
      const toastId = toast.loading("Pausing VM…");
      return { toastId };
    },
    onSuccess: (_data, _vars, context) => {
      toast.success("VM paused", { id: context?.toastId });
      queryClient.setQueryData(firecrackerPauseQueryKey(taskRunId, teamSlugOrId), {
        paused: true,
      });
    },
    onError: (error, _vars, context) => {
      toast.error(error.message, { id: context?.toastId });
    },
    onSettled: () => {
      void queryClient.invalidateQueries({
        queryKey: firecrackerPauseQueryKey(taskRunId, teamSlugOrId),
      });
    },
  });
}

export function useResumeFirecrackerWorkspace({
  taskRunId,
  teamSlugOrId,
  onSuccess,
  onError,
}: UseResumeFirecrackerWorkspaceArgs) {
  return useMutation<{ resumed: true }, Error, void, { toastId: string | number }>({
    mutationKey: ["firecracker", "resume", taskRunId],
    mutationFn: async () => {
      const res = await fetch(
        `/api/sandboxes/firecracker/task-runs/${encodeURIComponent(taskRunId)}/resume`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ teamSlugOrId }),
        },
      );
      if (!res.ok) {
        throw new Error(`Failed to resume VM: ${res.status}`);
      }
      return (await res.json()) as { resumed: true };
    },
    onMutate: () => {
      const toastId = toast.loading("Resuming VM…");
      return { toastId };
    },
    onSuccess: (_data, _vars, context) => {
      toast.success("VM resumed", { id: context?.toastId });
      queryClient.setQueryData(firecrackerPauseQueryKey(taskRunId, teamSlugOrId), {
        paused: false,
      });
      onSuccess?.();
    },
    onError: (error, _vars, context) => {
      toast.error(error.message, { id: context?.toastId });
      onError?.(error);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({
        queryKey: firecrackerPauseQueryKey(taskRunId, teamSlugOrId),
      });
    },
  });
}
