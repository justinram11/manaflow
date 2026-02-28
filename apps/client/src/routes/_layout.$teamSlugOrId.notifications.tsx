import { FloatingPane } from "@/components/floating-pane";
import { TitleBar } from "@/components/TitleBar";
import { queryClient } from "@/query-client";
import type { DbNotification } from "@cmux/www-openapi-client";
import {
  postApiNotificationsByIdRead,
  postApiNotificationsReadAll,
} from "@cmux/www-openapi-client";
import {
  getApiNotificationsOptions,
} from "@cmux/www-openapi-client/react-query";
import { Link, createFileRoute } from "@tanstack/react-router";
import clsx from "clsx";
import {
  useMutation as useRQMutation,
  useQuery as useRQ,
  useQueryClient,
} from "@tanstack/react-query";
import { CheckCircle, Circle, MessageCircleQuestion, XCircle } from "lucide-react";
import { useCallback, type MouseEvent } from "react";

export const Route = createFileRoute("/_layout/$teamSlugOrId/notifications")({
  component: NotificationsRoute,
  loader: async ({ params }) => {
    const { teamSlugOrId } = params;
    void queryClient.prefetchQuery(
      getApiNotificationsOptions({ query: { teamSlugOrId } })
    );
  },
});

function NotificationsRoute() {
  const { teamSlugOrId } = Route.useParams();
  const rqQueryClient = useQueryClient();
  const notificationsQuery = useRQ({
    ...getApiNotificationsOptions({ query: { teamSlugOrId } }),
    enabled: Boolean(teamSlugOrId),
  });
  const notifications = notificationsQuery.data?.notifications;

  const markAsReadMutation = useRQMutation({
    mutationFn: async (notificationId: string) => {
      const { data } = await postApiNotificationsByIdRead({
        path: { id: notificationId },
        throwOnError: true,
      });
      return data;
    },
    onSettled: () => {
      void rqQueryClient.invalidateQueries({
        queryKey: getApiNotificationsOptions({ query: { teamSlugOrId } }).queryKey,
      });
    },
  });

  const markAllAsReadMutation = useRQMutation({
    mutationFn: async () => {
      const { data } = await postApiNotificationsReadAll({
        body: { teamSlugOrId },
        throwOnError: true,
      });
      return data;
    },
    onSettled: () => {
      void rqQueryClient.invalidateQueries({
        queryKey: getApiNotificationsOptions({ query: { teamSlugOrId } }).queryKey,
      });
    },
  });

  const handleMarkAsRead = useCallback(
    (notificationId: string | undefined) => {
      if (notificationId) {
        markAsReadMutation.mutate(notificationId);
      }
    },
    [markAsReadMutation]
  );

  const handleMarkAllAsRead = useCallback(() => {
    markAllAsReadMutation.mutate();
  }, [markAllAsReadMutation]);

  const hasUnread = notifications?.some((n) => n.readAt == null) ?? false;

  return (
    <FloatingPane header={<TitleBar title="Notifications" />}>
      <div className="grow h-full flex flex-col">
        <div className="overflow-y-auto px-4 pb-6">
          {notifications === undefined ? (
            <div className="mt-6 space-y-3">
              {Array.from({ length: 5 }).map((_, i) => (
                <div
                  key={i}
                  className="h-16 bg-neutral-100 dark:bg-neutral-800 rounded-lg animate-pulse"
                />
              ))}
            </div>
          ) : notifications.length === 0 ? (
            <div className="mt-12 flex flex-col items-center justify-center text-neutral-500 dark:text-neutral-400">
              <p className="text-sm select-none">No notifications yet.</p>
            </div>
          ) : (
            <>
              {hasUnread && (
                <div className="mt-2 mb-3 flex justify-end">
                  <button
                    type="button"
                    onClick={handleMarkAllAsRead}
                    className="text-xs text-blue-600 dark:text-blue-400 hover:underline"
                  >
                    Mark all as read
                  </button>
                </div>
              )}
              <div className="mt-2 space-y-2">
                {notifications.map((notification) => (
                  <NotificationItem
                    key={notification.id}
                    notification={notification}
                    teamSlugOrId={teamSlugOrId}
                    onMarkAsRead={handleMarkAsRead}
                  />
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </FloatingPane>
  );
}

function NotificationItem({
  notification,
  teamSlugOrId,
  onMarkAsRead,
}: {
  notification: DbNotification;
  teamSlugOrId: string;
  onMarkAsRead: (notificationId: string | undefined) => void;
}) {
  const notificationType = notification.type;
  const Icon =
    notificationType === "run_completed"
      ? CheckCircle
      : notificationType === "run_needs_input"
        ? MessageCircleQuestion
        : XCircle;
  const isUnread = notification.readAt == null;

  const timeAgo = getTimeAgo(notification.createdAt);

  const handleClick = () => {
    // Only mark as read if currently unread
    if (isUnread) {
      onMarkAsRead(notification.id);
    }
  };

  const handleToggleRead = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (isUnread) {
      onMarkAsRead(notification.id);
    }
    // No "mark as unread" endpoint available
  };

  // Navigate to the specific run if available, otherwise to the task
  const linkTo = notification.taskRunId
    ? ("/$teamSlugOrId/task/$taskId/run/$runId" as const)
    : ("/$teamSlugOrId/task/$taskId" as const);

  const linkParams = notification.taskRunId
    ? {
        teamSlugOrId,
        taskId: notification.taskId,
        runId: notification.taskRunId,
      }
    : {
        teamSlugOrId,
        taskId: notification.taskId,
      };

  return (
    <Link
      to={linkTo}
      params={linkParams}
      onClick={handleClick}
      className={clsx(
        "group block px-4 py-3 rounded-lg border transition-colors",
        isUnread
          ? "bg-blue-50 border-blue-200 dark:bg-blue-950/30 dark:border-blue-900 hover:bg-blue-100 dark:hover:bg-blue-950/50"
          : "bg-neutral-50 border-neutral-200 dark:bg-neutral-900 dark:border-neutral-800 hover:bg-neutral-100 dark:hover:bg-neutral-800"
      )}
    >
      <div className="flex items-start gap-3">
        {/* Unread indicator */}
        <div className="mt-1.5 flex-shrink-0 w-2">
          {isUnread && (
            <span className="block size-2 rounded-full bg-blue-500" />
          )}
        </div>
        <div
          className={clsx(
            "mt-0.5 flex-shrink-0",
            notificationType === "run_completed"
              ? "text-green-600 dark:text-green-500"
              : notificationType === "run_needs_input"
                ? "text-amber-600 dark:text-amber-500"
                : "text-red-600 dark:text-red-500"
          )}
        >
          <Icon className="size-5" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-2">
            <p
              className={clsx(
                "text-sm truncate",
                isUnread
                  ? "font-semibold text-neutral-900 dark:text-neutral-100"
                  : "font-medium text-neutral-700 dark:text-neutral-300"
              )}
            >
              {notificationType === "run_completed"
                ? "Run completed"
                : notificationType === "run_needs_input"
                  ? "Run needs input"
                  : "Run failed"}
            </p>
            <span className="text-xs text-neutral-500 dark:text-neutral-400 flex-shrink-0">
              {timeAgo}
            </span>
          </div>
          {notification.message && (
            <p
              className={clsx(
                "text-sm mt-0.5 truncate",
                isUnread
                  ? "text-neutral-700 dark:text-neutral-300"
                  : "text-neutral-600 dark:text-neutral-400"
              )}
            >
              {notification.message}
            </p>
          )}
        </div>
        {/* Mark as read/unread button */}
        <button
          type="button"
          onClick={handleToggleRead}
          className="mt-0.5 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded hover:bg-neutral-200 dark:hover:bg-neutral-700"
          title={isUnread ? "Mark as read" : "Mark as unread"}
        >
          <Circle
            className={clsx(
              "size-4",
              isUnread
                ? "text-blue-500 fill-blue-500"
                : "text-neutral-400 dark:text-neutral-500"
            )}
          />
        </button>
      </div>
    </Link>
  );
}

function getTimeAgo(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (minutes > 0) return `${minutes}m ago`;
  return "Just now";
}
