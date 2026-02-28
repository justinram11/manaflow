import { TaskTree } from "@/components/TaskTree";
import { TaskTreeSkeleton } from "@/components/TaskTreeSkeleton";
import { FloatingPane } from "@/components/floating-pane";
import { useExpandTasks } from "@/contexts/expand-tasks/ExpandTasksContext";
import { queryClient } from "@/query-client";
import {
  getApiTasksNotificationOrderOptions,
  getApiUnreadTaskRunsOptions,
} from "@cmux/www-openapi-client/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery as useRQ } from "@tanstack/react-query";
import { useMemo } from "react";
import { env } from "@/client-env";
import type { TaskRunWithChildren } from "@/types/task";

export const Route = createFileRoute("/_layout/$teamSlugOrId/workspaces")({
  component: WorkspacesRoute,
  loader: async ({ params }) => {
    const { teamSlugOrId } = params;
    // In web mode, exclude local workspaces
    const excludeLocalWorkspaces = env.NEXT_PUBLIC_WEB_MODE ? "true" as const : undefined;
    void queryClient.prefetchQuery(
      getApiTasksNotificationOrderOptions({ query: { teamSlugOrId, excludeLocalWorkspaces } })
    );
  },
});

function WorkspacesRoute() {
  const { teamSlugOrId } = Route.useParams();
  // In web mode, exclude local workspaces
  const excludeLocalWorkspaces = env.NEXT_PUBLIC_WEB_MODE ? "true" as const : undefined;
  // Use notification-aware ordering: unread notifications first, then by createdAt
  const tasksQuery = useRQ({
    ...getApiTasksNotificationOrderOptions({ query: { teamSlugOrId, excludeLocalWorkspaces } }),
    enabled: Boolean(teamSlugOrId),
  });
  const tasks = tasksQuery.data?.tasks;

  const unreadQuery = useRQ({
    ...getApiUnreadTaskRunsOptions({ query: { teamSlugOrId } }),
    enabled: Boolean(teamSlugOrId),
  });
  const { expandTaskIds } = useExpandTasks();

  // Tasks are already sorted by the query (unread notifications first)
  const orderedTasks = useMemo(
    () => tasks ?? ([] as NonNullable<typeof tasks>),
    [tasks]
  );

  // Create a Set for quick lookup of task IDs with unread notifications
  const tasksWithUnreadSet = useMemo(() => {
    const unreadData = unreadQuery.data as { unreadTaskRuns?: Array<{ taskId: string }> } | undefined;
    if (!unreadData?.unreadTaskRuns) return new Set<string>();
    return new Set(unreadData.unreadTaskRuns.map((t) => t.taskId));
  }, [unreadQuery.data]);

  // For workspaces, we fetch task runs per task using individual queries
  // This is simplified - we pass runs as empty and let TaskTree handle loading
  const tasksWithRuns = useMemo(
    () =>
      orderedTasks.map((task) => ({
        ...task,
        runs: [] as TaskRunWithChildren[],
      })),
    [orderedTasks]
  );

  return (
    <FloatingPane>
      <div className="grow h-full flex flex-col">
        <div className="border-b border-neutral-200 px-6 py-4 dark:border-neutral-800">
          <h1 className="text-base font-semibold text-neutral-900 dark:text-neutral-100 select-none">
            Workspaces
          </h1>
        </div>
        <div className="overflow-y-auto px-4 pb-6">
          {tasks === undefined ? (
            <TaskTreeSkeleton count={10} />
          ) : tasksWithRuns.length === 0 ? (
            <p className="mt-6 text-sm text-neutral-500 dark:text-neutral-400 select-none">
              No workspaces yet.
            </p>
          ) : (
            <div className="mt-2 space-y-1">
              {tasksWithRuns.map((task) => {
                const taskId = task.id;
                return (
                  <TaskTree
                    key={taskId}
                    task={task as React.ComponentProps<typeof TaskTree>["task"]}
                    defaultExpanded={expandTaskIds?.includes(taskId) ?? false}
                    teamSlugOrId={teamSlugOrId}
                    hasUnreadNotification={tasksWithUnreadSet.has(taskId)}
                  />
                );
              })}
            </div>
          )}
        </div>
      </div>
    </FloatingPane>
  );
}
