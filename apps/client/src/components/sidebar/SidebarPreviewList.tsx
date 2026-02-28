import { TaskTree } from "@/components/TaskTree";
import { TaskTreeSkeleton } from "@/components/TaskTreeSkeleton";
import {
  getApiTasksOptions,
} from "@cmux/www-openapi-client/react-query";
import { useQuery } from "@tanstack/react-query";

type Props = {
  teamSlugOrId: string;
};

export function SidebarPreviewList({ teamSlugOrId }: Props) {
  // Preview tasks are not a separate endpoint in the HTTP API;
  // we filter tasks that have isPreview set
  const tasksQuery = useQuery(
    getApiTasksOptions({ query: { teamSlugOrId } }),
  );
  const tasks = tasksQuery.data?.tasks?.filter((t) => t.isPreview);

  if (tasks === undefined) {
    return <TaskTreeSkeleton count={3} />;
  }

  if (tasks.length === 0) {
    return (
      <p className="mt-1 pl-2 pr-3 py-2 text-xs text-neutral-500 dark:text-neutral-400 select-none">
        No preview runs
      </p>
    );
  }

  return (
    <div className="space-y-px">
      {tasks.map((task) => (
        <TaskTree
          key={task.id}
          task={task}
          defaultExpanded={false}
          teamSlugOrId={teamSlugOrId}
        />
      ))}
    </div>
  );
}

export default SidebarPreviewList;
