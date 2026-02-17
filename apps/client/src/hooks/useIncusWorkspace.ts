import { useMutation, useQuery } from "@tanstack/react-query";
import { useQuery as useConvexQuery } from "convex/react";
import { api } from "@cmux/convex/api";
import type { Id } from "@cmux/convex/dataModel";
import { toast } from "sonner";
import { queryClient } from "@/query-client";

interface IncusWorkspaceQueryArgs {
  taskRunId: Id<"taskRuns">;
  teamSlugOrId: string;
  enabled?: boolean;
}

interface UseResumeIncusWorkspaceArgs {
  taskRunId: Id<"taskRuns">;
  teamSlugOrId: string;
  onSuccess?: () => void;
  onError?: (error: unknown) => void;
}

export function incusPauseQueryKey(taskRunId: string, teamSlugOrId: string) {
  return ["incus", "task-run", taskRunId, "paused", teamSlugOrId] as const;
}

/**
 * Check whether a task run is backed by Incus.
 * Handles both the new "incus" provider and legacy "docker" with cmux- prefix.
 */
function isIncusProvider(provider?: string, containerName?: string): boolean {
  if (provider === "incus") return true;
  if (provider === "docker" && containerName?.startsWith("cmux-")) return true;
  return false;
}

export function useIncusPauseQuery({
  taskRunId,
  teamSlugOrId,
  enabled,
}: IncusWorkspaceQueryArgs) {
  const taskRun = useConvexQuery(api.taskRuns.get, {
    teamSlugOrId,
    id: taskRunId,
  });
  const canQuery = isIncusProvider(
    taskRun?.vscode?.provider,
    taskRun?.vscode?.containerName ?? undefined,
  );

  return useQuery({
    enabled: canQuery && enabled !== false,
    queryKey: incusPauseQueryKey(taskRunId, teamSlugOrId),
    queryFn: async ({ signal }) => {
      const res = await fetch(
        `/api/sandboxes/incus/task-runs/${encodeURIComponent(taskRunId)}/is-paused`,
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

export function useIncusPause({
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
    mutationKey: ["incus", "pause", taskRunId],
    mutationFn: async () => {
      const containerName = taskRun?.vscode?.containerName;
      if (!containerName) throw new Error("No container found");

      const res = await fetch(
        `/api/sandboxes/incus/${encodeURIComponent(containerName)}/pause`,
        { method: "POST" },
      );
      if (!res.ok) {
        throw new Error(`Failed to pause container: ${res.status}`);
      }
      return (await res.json()) as { paused: true };
    },
    onMutate: () => {
      const toastId = toast.loading("Pausing container…");
      return { toastId };
    },
    onSuccess: (_data, _vars, context) => {
      toast.success("Container paused", { id: context?.toastId });
      queryClient.setQueryData(incusPauseQueryKey(taskRunId, teamSlugOrId), {
        paused: true,
      });
    },
    onError: (error, _vars, context) => {
      toast.error(error.message, { id: context?.toastId });
    },
    onSettled: () => {
      void queryClient.invalidateQueries({
        queryKey: incusPauseQueryKey(taskRunId, teamSlugOrId),
      });
    },
  });
}

export function useResumeIncusWorkspace({
  taskRunId,
  teamSlugOrId,
  onSuccess,
  onError,
}: UseResumeIncusWorkspaceArgs) {
  return useMutation<{ resumed: true }, Error, void, { toastId: string | number }>({
    mutationKey: ["incus", "resume", taskRunId],
    mutationFn: async () => {
      const res = await fetch(
        `/api/sandboxes/incus/task-runs/${encodeURIComponent(taskRunId)}/resume`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ teamSlugOrId }),
        },
      );
      if (!res.ok) {
        throw new Error(`Failed to resume container: ${res.status}`);
      }
      return (await res.json()) as { resumed: true };
    },
    onMutate: () => {
      const toastId = toast.loading("Resuming container…");
      return { toastId };
    },
    onSuccess: (_data, _vars, context) => {
      toast.success("Container resumed", { id: context?.toastId });
      queryClient.setQueryData(incusPauseQueryKey(taskRunId, teamSlugOrId), {
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
        queryKey: incusPauseQueryKey(taskRunId, teamSlugOrId),
      });
    },
  });
}
