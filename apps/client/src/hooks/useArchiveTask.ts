import { useSocket } from "@/contexts/socket/use-socket";
import {
  postApiTasksByIdArchive,
  postApiTasksByIdUnarchive,
} from "@cmux/www-openapi-client";
import {
  getApiTasksQueryKey,
  getApiTasksByIdQueryKey,
  getApiTasksPinnedQueryKey,
  getApiTasksNotificationOrderQueryKey,
} from "@cmux/www-openapi-client/react-query";
import type { DbTask, DbTaskListResponse } from "@cmux/www-openapi-client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { toast } from "sonner";

function hasIncusRuns(task: DbTask & { taskRuns?: Array<{ vscode?: { provider?: string; containerName?: string } }> }): boolean {
  const runs = task.taskRuns;
  if (!Array.isArray(runs)) return false;
  return runs.some((run: { vscode?: { provider?: string; containerName?: string } }) => {
    if (run.vscode?.provider === "incus") return true;
    if (run.vscode?.provider === "aws") return true;
    if (run.vscode?.provider === "docker" && run.vscode.containerName?.startsWith("cmux-")) return true;
    return false;
  });
}

export function useArchiveTask(teamSlugOrId: string) {
  const { socket } = useSocket();
  const queryClient = useQueryClient();
  const [archivingTaskIds, setArchivingTaskIds] = useState<Set<string>>(
    new Set()
  );

  const archiveMutation = useMutation({
    mutationFn: (taskId: string) =>
      postApiTasksByIdArchive({
        path: { id: taskId },
        body: { teamSlugOrId },
        throwOnError: true,
      }),
    onMutate: async (taskId: string) => {
      // Cancel ongoing queries
      const tasksKey = getApiTasksQueryKey({ query: { teamSlugOrId } });
      const archivedKey = getApiTasksQueryKey({ query: { teamSlugOrId, archived: "true" } });
      const activeKey = getApiTasksQueryKey({ query: { teamSlugOrId, archived: "false" } });
      const detailKey = getApiTasksByIdQueryKey({ path: { id: taskId }, query: { teamSlugOrId } });
      const pinnedKey = getApiTasksPinnedQueryKey({ query: { teamSlugOrId } });
      const notifOrderKey = getApiTasksNotificationOrderQueryKey({ query: { teamSlugOrId } });

      await Promise.all([
        queryClient.cancelQueries({ queryKey: tasksKey }),
        queryClient.cancelQueries({ queryKey: archivedKey }),
        queryClient.cancelQueries({ queryKey: activeKey }),
        queryClient.cancelQueries({ queryKey: detailKey }),
        queryClient.cancelQueries({ queryKey: pinnedKey }),
        queryClient.cancelQueries({ queryKey: notifOrderKey }),
      ]);

      // Save previous values for rollback
      const previousTasks = queryClient.getQueryData<DbTaskListResponse>(tasksKey);
      const previousActive = queryClient.getQueryData<DbTaskListResponse>(activeKey);
      const previousArchived = queryClient.getQueryData<DbTaskListResponse>(archivedKey);
      const previousDetail = queryClient.getQueryData(detailKey);
      const previousPinned = queryClient.getQueryData<DbTaskListResponse>(pinnedKey);
      const previousNotifOrder = queryClient.getQueryData<DbTaskListResponse>(notifOrderKey);

      // Optimistically remove from active lists
      const removeFromList = (data: DbTaskListResponse | undefined) => {
        if (!data) return data;
        return { ...data, tasks: data.tasks.filter((t) => t.id !== taskId) };
      };

      queryClient.setQueryData(tasksKey, removeFromList(previousTasks));
      queryClient.setQueryData(activeKey, removeFromList(previousActive));
      queryClient.setQueryData(pinnedKey, removeFromList(previousPinned));
      queryClient.setQueryData(notifOrderKey, removeFromList(previousNotifOrder));

      // Add to archived list if it exists
      if (previousArchived) {
        const archivedTask = previousTasks?.tasks.find((t) => t.id === taskId);
        if (archivedTask) {
          queryClient.setQueryData(archivedKey, {
            ...previousArchived,
            tasks: [{ ...archivedTask, isArchived: true }, ...previousArchived.tasks],
          });
        }
      }

      // Update detail view
      if (previousDetail) {
        queryClient.setQueryData(detailKey, { ...previousDetail, isArchived: true });
      }

      return { previousTasks, previousActive, previousArchived, previousDetail, previousPinned, previousNotifOrder };
    },
    onError: (_err, taskId, context) => {
      // Rollback on error
      if (context) {
        const tasksKey = getApiTasksQueryKey({ query: { teamSlugOrId } });
        const activeKey = getApiTasksQueryKey({ query: { teamSlugOrId, archived: "false" } });
        const archivedKey = getApiTasksQueryKey({ query: { teamSlugOrId, archived: "true" } });
        const detailKey = getApiTasksByIdQueryKey({ path: { id: taskId }, query: { teamSlugOrId } });
        const pinnedKey = getApiTasksPinnedQueryKey({ query: { teamSlugOrId } });
        const notifOrderKey = getApiTasksNotificationOrderQueryKey({ query: { teamSlugOrId } });

        if (context.previousTasks) queryClient.setQueryData(tasksKey, context.previousTasks);
        if (context.previousActive) queryClient.setQueryData(activeKey, context.previousActive);
        if (context.previousArchived) queryClient.setQueryData(archivedKey, context.previousArchived);
        if (context.previousDetail) queryClient.setQueryData(detailKey, context.previousDetail);
        if (context.previousPinned) queryClient.setQueryData(pinnedKey, context.previousPinned);
        if (context.previousNotifOrder) queryClient.setQueryData(notifOrderKey, context.previousNotifOrder);
      }
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: getApiTasksQueryKey({ query: { teamSlugOrId } }) });
      void queryClient.invalidateQueries({ queryKey: getApiTasksPinnedQueryKey({ query: { teamSlugOrId } }) });
      void queryClient.invalidateQueries({ queryKey: getApiTasksNotificationOrderQueryKey({ query: { teamSlugOrId } }) });
    },
  });

  const unarchiveMutation = useMutation({
    mutationFn: (taskId: string) =>
      postApiTasksByIdUnarchive({
        path: { id: taskId },
        body: { teamSlugOrId },
        throwOnError: true,
      }),
    onMutate: async (taskId: string) => {
      const tasksKey = getApiTasksQueryKey({ query: { teamSlugOrId } });
      const archivedKey = getApiTasksQueryKey({ query: { teamSlugOrId, archived: "true" } });
      const activeKey = getApiTasksQueryKey({ query: { teamSlugOrId, archived: "false" } });
      const detailKey = getApiTasksByIdQueryKey({ path: { id: taskId }, query: { teamSlugOrId } });

      await Promise.all([
        queryClient.cancelQueries({ queryKey: tasksKey }),
        queryClient.cancelQueries({ queryKey: archivedKey }),
        queryClient.cancelQueries({ queryKey: activeKey }),
        queryClient.cancelQueries({ queryKey: detailKey }),
      ]);

      const previousTasks = queryClient.getQueryData<DbTaskListResponse>(tasksKey);
      const previousActive = queryClient.getQueryData<DbTaskListResponse>(activeKey);
      const previousArchived = queryClient.getQueryData<DbTaskListResponse>(archivedKey);
      const previousDetail = queryClient.getQueryData(detailKey);

      // Remove from archived list
      if (previousArchived) {
        const task = previousArchived.tasks.find((t) => t.id === taskId);
        queryClient.setQueryData(archivedKey, {
          ...previousArchived,
          tasks: previousArchived.tasks.filter((t) => t.id !== taskId),
        });

        // Add to active lists
        if (task) {
          const restoredTask = { ...task, isArchived: false };
          if (previousActive) {
            queryClient.setQueryData(activeKey, {
              ...previousActive,
              tasks: [restoredTask, ...previousActive.tasks],
            });
          }
          if (previousTasks) {
            queryClient.setQueryData(tasksKey, {
              ...previousTasks,
              tasks: [restoredTask, ...previousTasks.tasks],
            });
          }
        }
      }

      // Update detail view
      if (previousDetail) {
        queryClient.setQueryData(detailKey, { ...previousDetail, isArchived: false });
      }

      return { previousTasks, previousActive, previousArchived, previousDetail };
    },
    onError: (_err, taskId, context) => {
      if (context) {
        const tasksKey = getApiTasksQueryKey({ query: { teamSlugOrId } });
        const activeKey = getApiTasksQueryKey({ query: { teamSlugOrId, archived: "false" } });
        const archivedKey = getApiTasksQueryKey({ query: { teamSlugOrId, archived: "true" } });
        const detailKey = getApiTasksByIdQueryKey({ path: { id: taskId }, query: { teamSlugOrId } });

        if (context.previousTasks) queryClient.setQueryData(tasksKey, context.previousTasks);
        if (context.previousActive) queryClient.setQueryData(activeKey, context.previousActive);
        if (context.previousArchived) queryClient.setQueryData(archivedKey, context.previousArchived);
        if (context.previousDetail) queryClient.setQueryData(detailKey, context.previousDetail);
      }
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: getApiTasksQueryKey({ query: { teamSlugOrId } }) });
      void queryClient.invalidateQueries({ queryKey: getApiTasksPinnedQueryKey({ query: { teamSlugOrId } }) });
      void queryClient.invalidateQueries({ queryKey: getApiTasksNotificationOrderQueryKey({ query: { teamSlugOrId } }) });
    },
  });

  const archiveWithUndo = useCallback(
    async (task: DbTask & { taskRuns?: Array<{ vscode?: { provider?: string; containerName?: string } }> }) => {
      // Warn when archiving Incus tasks - containers will be permanently deleted
      if (hasIncusRuns(task)) {
        const confirmed = window.confirm(
          "This will permanently delete the Incus container(s) and their data. Continue?"
        );
        if (!confirmed) return;
      }

      const taskId = task.id;
      setArchivingTaskIds((prev) => new Set(prev).add(taskId));

      try {
        await archiveMutation.mutateAsync(taskId);

        // Emit socket event to stop/pause containers
        if (socket) {
          socket.emit(
            "archive-task",
            { taskId },
            (response: { success: boolean; error?: string }) => {
              if (!response.success) {
                console.error("Failed to stop containers:", response.error);
              }
            }
          );
        }

        toast("Task archived", {
          action: {
            label: "Undo",
            onClick: () => unarchiveMutation.mutate(taskId),
          },
        });
      } finally {
        setArchivingTaskIds((prev) => {
          const next = new Set(prev);
          next.delete(taskId);
          return next;
        });
      }
    },
    [archiveMutation, socket, unarchiveMutation]
  );

  const archive = useCallback(
    async (id: string) => {
      setArchivingTaskIds((prev) => new Set(prev).add(id));

      try {
        await archiveMutation.mutateAsync(id);

        // Emit socket event to stop/pause containers
        if (socket) {
          socket.emit(
            "archive-task",
            { taskId: id },
            (response: { success: boolean; error?: string }) => {
              if (!response.success) {
                console.error("Failed to stop containers:", response.error);
              }
            }
          );
        }
      } finally {
        setArchivingTaskIds((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }
    },
    [archiveMutation, socket]
  );

  const isArchiving = useCallback(
    (id: string) => archivingTaskIds.has(id),
    [archivingTaskIds]
  );

  return {
    archive,
    unarchive: (id: string) => unarchiveMutation.mutate(id),
    archiveWithUndo,
    isArchiving,
  };
}
