import { api } from "@cmux/convex/api";
import { typedZid } from "@cmux/shared/utils/typed-zid";
import { convexQuery } from "@convex-dev/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "convex/react";
import clsx from "clsx";
import { useCallback, useEffect, useMemo, useState } from "react";
import { PersistentWebView } from "@/components/persistent-webview";
import type { PersistentIframeStatus } from "@/components/persistent-iframe";
import { WorkspaceLoadingIndicator } from "@/components/workspace-loading-indicator";
import { getTaskRunPersistKey } from "@/lib/persistent-webview-keys";
import { toProxyWorkspaceUrl } from "@/lib/toProxyWorkspaceUrl";
import {
  TASK_RUN_IFRAME_ALLOW,
  TASK_RUN_IFRAME_SANDBOX,
  preloadTaskRunIframes,
} from "../lib/preloadTaskRunIframes";
import { shouldUseServerIframePreflight } from "@/hooks/useIframePreflight";
import {
  localVSCodeServeWebQueryOptions,
  useLocalVSCodeServeWebQuery,
} from "@/queries/local-vscode-serve-web";
import { convexQueryClient } from "@/contexts/convex/convex-query-client";
import { ResumeWorkspaceOverlay } from "@/components/resume-workspace-overlay";

export const Route = createFileRoute(
  "/_layout/$teamSlugOrId/task/$taskId/run/$runId/"
)({
  component: TaskRunComponent,
  parseParams: (params) => ({
    ...params,
    taskRunId: typedZid("taskRuns").parse(params.runId),
  }),
  loader: async (opts) => {
    convexQueryClient.convexClient.prewarmQuery({
      query: api.taskRuns.get,
      args: {
        teamSlugOrId: opts.params.teamSlugOrId,
        id: opts.params.taskRunId,
      },
    });

    void (async () => {
      const [result, localServeWeb] = await Promise.all([
        opts.context.queryClient.ensureQueryData(
          convexQuery(api.taskRuns.get, {
            teamSlugOrId: opts.params.teamSlugOrId,
            id: opts.params.taskRunId,
          })
        ),
        opts.context.queryClient.ensureQueryData(
          localVSCodeServeWebQueryOptions()
        ),
      ]);
      if (result) {
        const workspaceUrl = result.vscode?.workspaceUrl;
        void preloadTaskRunIframes([
          {
            url: workspaceUrl
              ? toProxyWorkspaceUrl(workspaceUrl, localServeWeb.baseUrl)
              : "",
            taskRunId: opts.params.taskRunId,
          },
        ]);
      }
    })();
  },
});

function TaskRunComponent() {
  const { taskRunId, teamSlugOrId } = Route.useParams();
  const localServeWeb = useLocalVSCodeServeWebQuery();
  const taskRun = useQuery(api.taskRuns.get, {
    teamSlugOrId,
    id: taskRunId,
  });

  const rawWorkspaceUrl = taskRun?.vscode?.workspaceUrl ?? null;
  const workspaceUrl = rawWorkspaceUrl
    ? toProxyWorkspaceUrl(rawWorkspaceUrl, localServeWeb.data?.baseUrl)
    : null;
  const disablePreflight = rawWorkspaceUrl
    ? shouldUseServerIframePreflight(rawWorkspaceUrl)
    : false;
  const persistKey = getTaskRunPersistKey(taskRunId);
  const hasWorkspace = workspaceUrl !== null;
  const isLocalWorkspace = taskRun?.vscode?.provider === "other";
  const [iframeStatus, setIframeStatus] =
    useState<PersistentIframeStatus>("loading");

  useEffect(() => {
    setIframeStatus("loading");
  }, [workspaceUrl]);

  const onLoad = useCallback(() => {
    console.log(`Workspace view loaded for task run ${taskRunId}`);
  }, [taskRunId]);

  const onError = useCallback(
    (error: Error) => {
      console.error(
        `Failed to load workspace view for task run ${taskRunId}:`,
        error
      );
    },
    [taskRunId]
  );

  const loadingFallback = useMemo(
    () =>
      isLocalWorkspace ? null : (
        <WorkspaceLoadingIndicator variant="vscode" status="loading" />
      ),
    [isLocalWorkspace]
  );
  const errorFallback = useMemo(
    () => <WorkspaceLoadingIndicator variant="vscode" status="error" />,
    []
  );

  const isEditorBusy = !hasWorkspace || iframeStatus !== "loaded";

  return (
    <div className="flex flex-col grow bg-neutral-50 dark:bg-black">
      <div className="flex flex-col grow min-h-0 border-l border-neutral-200 dark:border-neutral-800">
        <div
          className="flex flex-row grow min-h-0 relative"
          aria-busy={isEditorBusy}
        >
          {workspaceUrl ? (
            <PersistentWebView
              persistKey={persistKey}
              src={workspaceUrl}
              className="grow flex relative"
              iframeClassName="select-none"
              allow={TASK_RUN_IFRAME_ALLOW}
              sandbox={TASK_RUN_IFRAME_SANDBOX}
              preflight={!disablePreflight}
              retainOnUnmount
              suspended={!hasWorkspace}
              onLoad={onLoad}
              onError={onError}
              fallback={loadingFallback}
              fallbackClassName="bg-neutral-50 dark:bg-black"
              errorFallback={errorFallback}
              errorFallbackClassName="bg-neutral-50/95 dark:bg-black/95"
              onStatusChange={setIframeStatus}
              loadTimeoutMs={60_000}
            />
          ) : (
            <div className="grow" />
          )}
          {!isLocalWorkspace ? (
            <div
              className={clsx(
                "absolute inset-0 flex items-center justify-center transition pointer-events-none",
                {
                  "opacity-100": !hasWorkspace,
                  "opacity-0": hasWorkspace,
                }
              )}
            >
              <WorkspaceLoadingIndicator variant="vscode" status="loading" />
            </div>
          ) : null}
          {taskRun ? (
            <ResumeWorkspaceOverlay
              taskRun={taskRun}
              teamSlugOrId={teamSlugOrId}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}
