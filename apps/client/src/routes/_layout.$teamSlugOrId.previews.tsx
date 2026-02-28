import { TaskTree } from "@/components/TaskTree";
import { TaskTreeSkeleton } from "@/components/TaskTreeSkeleton";
import { FloatingPane } from "@/components/floating-pane";
import { useExpandTasks } from "@/contexts/expand-tasks/ExpandTasksContext";
import { queryClient } from "@/query-client";
import {
  getApiTasksOptions,
} from "@cmux/www-openapi-client/react-query";
import { useQuery as useRQ } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useMemo } from "react";

export const Route = createFileRoute("/_layout/$teamSlugOrId/previews")({
  component: PreviewsRoute,
  loader: async ({ params }) => {
    const { teamSlugOrId } = params;
    void queryClient.prefetchQuery(
      getApiTasksOptions({ query: { teamSlugOrId } })
    );
  },
});

function PreviewsRoute() {
  const { teamSlugOrId } = Route.useParams();
  const tasksQuery = useRQ({
    ...getApiTasksOptions({ query: { teamSlugOrId } }),
    enabled: Boolean(teamSlugOrId),
  });
  const allTasks = tasksQuery.data?.tasks;
  // Filter to preview tasks client-side (no dedicated REST endpoint)
  const tasks = useMemo(
    () => allTasks?.filter((task) => task.isPreview === true),
    [allTasks]
  );
  const { expandTaskIds } = useExpandTasks();

  return (
    <FloatingPane>
      <div className="grow h-full flex flex-col">
        <div className="border-b border-neutral-200 px-6 py-4 dark:border-neutral-800">
          <h1 className="text-base font-semibold text-neutral-900 dark:text-neutral-100 select-none">
            Previews
          </h1>
        </div>
        <div className="overflow-y-auto px-4 pb-6">
          {tasks === undefined ? (
            <TaskTreeSkeleton count={10} />
          ) : tasks.length === 0 ? (
            <p className="mt-6 text-sm text-neutral-500 dark:text-neutral-400 select-none">
              No preview runs yet.
            </p>
          ) : (
            <div className="mt-2 space-y-1">
              {tasks.map((task) => (
                <TaskTree
                  key={task.id}
                  task={task}
                  defaultExpanded={expandTaskIds?.includes(task.id) ?? false}
                  teamSlugOrId={teamSlugOrId}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </FloatingPane>
  );
}
