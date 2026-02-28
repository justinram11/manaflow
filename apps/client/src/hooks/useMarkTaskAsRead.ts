import {
  postApiTasksByTaskIdMarkAllRead,
} from "@cmux/www-openapi-client";
import type { GetApiUnreadTaskRunsResponse } from "@cmux/www-openapi-client";
import {
  getApiUnreadTaskRunsQueryKey,
  getApiTasksQueryKey,
  getApiTasksNotificationOrderQueryKey,
} from "@cmux/www-openapi-client/react-query";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

export function useSetTaskReadState(teamSlugOrId: string) {
  const queryClient = useQueryClient();

  const markAsReadMutation = useMutation({
    mutationFn: (taskId: string) =>
      postApiTasksByTaskIdMarkAllRead({
        path: { taskId },
        throwOnError: true,
      }),
    onMutate: async (taskId: string) => {
      const unreadKey = getApiUnreadTaskRunsQueryKey({ query: { teamSlugOrId } });
      await queryClient.cancelQueries({ queryKey: unreadKey });

      const previousUnread = queryClient.getQueryData<GetApiUnreadTaskRunsResponse>(unreadKey);

      // Optimistically remove all unread entries for this task
      if (previousUnread) {
        queryClient.setQueryData(unreadKey, {
          ...previousUnread,
          unreadTaskRuns: previousUnread.unreadTaskRuns.filter(
            (entry) => entry.taskId !== taskId
          ),
        });
      }

      return { previousUnread };
    },
    onError: (_err, _taskId, context) => {
      if (context?.previousUnread) {
        const unreadKey = getApiUnreadTaskRunsQueryKey({ query: { teamSlugOrId } });
        queryClient.setQueryData(unreadKey, context.previousUnread);
      }
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: getApiUnreadTaskRunsQueryKey({ query: { teamSlugOrId } }) });
      void queryClient.invalidateQueries({ queryKey: getApiTasksQueryKey({ query: { teamSlugOrId } }) });
      void queryClient.invalidateQueries({ queryKey: getApiTasksNotificationOrderQueryKey({ query: { teamSlugOrId } }) });
    },
  });

  // Mark as unread is not directly available in the new API, so we just invalidate
  // to let the server state be authoritative. For now, we use the same mark-all-read
  // endpoint since the old Convex "markAsUnread" is no longer needed.
  // If a dedicated unread endpoint is added later, use it here.
  const markAsUnreadMutation = useMutation({
    mutationFn: (_taskId: string) => {
      // No direct "mark as unread" endpoint in the new API.
      // This is a no-op that just invalidates caches.
      return Promise.resolve({ success: true });
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: getApiUnreadTaskRunsQueryKey({ query: { teamSlugOrId } }) });
      void queryClient.invalidateQueries({ queryKey: getApiTasksQueryKey({ query: { teamSlugOrId } }) });
      void queryClient.invalidateQueries({ queryKey: getApiTasksNotificationOrderQueryKey({ query: { teamSlugOrId } }) });
    },
  });

  return useCallback(
    (taskId: string, isRead: boolean) => {
      if (isRead) {
        return markAsReadMutation.mutateAsync(taskId);
      }
      return markAsUnreadMutation.mutateAsync(taskId);
    },
    [markAsReadMutation, markAsUnreadMutation]
  );
}
