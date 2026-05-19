import { TaskRunAndroidPane } from "@/components/TaskRunAndroidPane";
import { queryClient } from "@/query-client";
import { getApiTaskRunsByIdOptions } from "@cmux/www-openapi-client/react-query";
import { typedZid } from "@cmux/shared/utils/typed-zid";
import { createFileRoute } from "@tanstack/react-router";
import z from "zod";

const paramsSchema = z.object({
  taskId: typedZid("tasks"),
  runId: typedZid("taskRuns"),
});

export const Route = createFileRoute(
  "/_layout/$teamSlugOrId/task/$taskId/run/$runId/android"
)({
  component: AndroidComponent,
  params: {
    parse: paramsSchema.parse,
    stringify: (params) => ({
      taskId: params.taskId,
      runId: params.runId,
    }),
  },
  loader: async (opts) => {
    void queryClient.prefetchQuery(
      getApiTaskRunsByIdOptions({
        path: { id: opts.params.runId },
      })
    );
  },
});

function AndroidComponent() {
  const { runId: taskRunId } = Route.useParams();
  return <TaskRunAndroidPane taskRunId={taskRunId} />;
}
