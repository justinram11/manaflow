import { TaskRunAndroidPane } from "@/components/TaskRunAndroidPane";
import { TaskRunSimulatorPane } from "@/components/TaskRunSimulatorPane";
import { queryClient } from "@/query-client";
import { getApiTaskRunsByIdOptions } from "@cmux/www-openapi-client/react-query";
import { useQuery } from "@tanstack/react-query";
import { typedZid } from "@cmux/shared/utils/typed-zid";
import { createFileRoute } from "@tanstack/react-router";
import z from "zod";

const paramsSchema = z.object({
  taskId: typedZid("tasks"),
  runId: typedZid("taskRuns"),
});

export const Route = createFileRoute(
  "/_layout/$teamSlugOrId/task/$taskId/run/$runId/simulator"
)({
  component: SimulatorComponent,
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

function SimulatorComponent() {
  const { runId: taskRunId } = Route.useParams();
  const { data: taskRun } = useQuery({
    ...getApiTaskRunsByIdOptions({ path: { id: taskRunId } }),
    enabled: Boolean(taskRunId),
  });

  const vscode = (taskRun?.vscode ?? null) as {
    iosResourceAllocationId?: string;
    iosVmMcpUrl?: string;
    androidResourceAllocationId?: string;
    androidVmMcpUrl?: string;
  } | null;

  // Android takes precedence only when iOS is not present — iOS allocations
  // are the historical default for this route.
  const hasIos =
    Boolean(vscode?.iosResourceAllocationId) || Boolean(vscode?.iosVmMcpUrl);
  const hasAndroid =
    Boolean(vscode?.androidResourceAllocationId) ||
    Boolean(vscode?.androidVmMcpUrl);

  if (!hasIos && hasAndroid) {
    return <TaskRunAndroidPane taskRunId={taskRunId} />;
  }
  return <TaskRunSimulatorPane taskRunId={taskRunId} />;
}
