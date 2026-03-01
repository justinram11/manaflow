import { VncViewer, type VncConnectionStatus } from "@cmux/shared/components/vnc-viewer";
import { WorkspaceLoadingIndicator } from "@/components/workspace-loading-indicator";
import { toVncWebsocketUrl } from "@/lib/toProxyWorkspaceUrl";
import { typedZid } from "@cmux/shared/utils/typed-zid";
import { createFileRoute } from "@tanstack/react-router";
import clsx from "clsx";
import { useCallback, useMemo, useState } from "react";
import z from "zod";
import { queryClient } from "@/query-client";
import {
  getApiTaskRunsByIdOptions,
} from "@cmux/www-openapi-client/react-query";
import { useQuery as useRQ } from "@tanstack/react-query";

const paramsSchema = z.object({
  taskId: typedZid("tasks"),
  runId: typedZid("taskRuns"),
});

export const Route = createFileRoute(
  "/_layout/$teamSlugOrId/task/$taskId/run/$runId/browser"
)({
  component: BrowserComponent,
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

function BrowserComponent() {
  const { runId: taskRunId, teamSlugOrId } = Route.useParams();
  const taskRunQuery = useRQ({
    ...getApiTaskRunsByIdOptions({ path: { id: taskRunId } }),
    enabled: Boolean(teamSlugOrId && taskRunId),
  });
  const taskRun = taskRunQuery.data;

  const vscodeInfo = (taskRun?.vscode ?? null) as { url?: string; workspaceUrl?: string; provider?: string; ports?: Record<string, unknown> } | null;
  const rawUrl = vscodeInfo?.url ?? vscodeInfo?.workspaceUrl ?? null;
  const provider = vscodeInfo?.provider;
  const ports = vscodeInfo?.ports;
  const vncWebsocketUrl = useMemo(() => {
    if (!rawUrl || !provider) {
      return null;
    }
    return toVncWebsocketUrl(rawUrl, provider, ports ?? undefined);
  }, [rawUrl, provider, ports]);

  const hasBrowserView = Boolean(vncWebsocketUrl);
  const hasCloudBackend = provider === "morph" || provider === "docker" || provider === "incus" || provider === "aws";
  const showLoader = hasCloudBackend && !hasBrowserView;

  const [vncStatus, setVncStatus] = useState<VncConnectionStatus>("disconnected");

  const overlayMessage = useMemo(() => {
    if (!hasCloudBackend) {
      return "Browser preview is loading. Note that browser preview is only supported in cloud mode.";
    }
    if (!hasBrowserView) {
      return "Waiting for the workspace to expose a browser preview...";
    }
    return "Launching browser preview...";
  }, [hasBrowserView, hasCloudBackend]);

  const onConnect = useCallback(() => {
    console.log(`Browser VNC connected for task run ${taskRunId}`);
  }, [taskRunId]);

  const onDisconnect = useCallback(
    (_rfb: unknown, detail: { clean: boolean }) => {
      console.log(
        `Browser VNC disconnected for task run ${taskRunId} (clean: ${detail.clean})`
      );
    },
    [taskRunId]
  );

  const loadingFallback = useMemo(
    () => <WorkspaceLoadingIndicator variant="browser" status="loading" />,
    []
  );
  const errorFallback = useMemo(
    () => <WorkspaceLoadingIndicator variant="browser" status="error" />,
    []
  );

  const isBrowserBusy = !hasBrowserView || vncStatus !== "connected";

  return (
    <div className="flex flex-col grow bg-neutral-50 dark:bg-black">
      <div className="flex flex-col grow min-h-0 border-l border-neutral-200 dark:border-neutral-800">
        <div
          className="flex flex-row grow min-h-0 relative"
          aria-busy={isBrowserBusy}
        >
          {vncWebsocketUrl ? (
            <VncViewer
              url={vncWebsocketUrl}
              className="grow"
              background="#000000"
              scaleViewport
              autoConnect
              autoReconnect
              reconnectDelay={1000}
              maxReconnectDelay={30000}
              focusOnClick
              onConnect={onConnect}
              onDisconnect={onDisconnect}
              onStatusChange={setVncStatus}
              loadingFallback={loadingFallback}
              errorFallback={errorFallback}
            />
          ) : (
            <div className="grow" />
          )}
          <div
            className={clsx(
              "absolute inset-0 flex items-center justify-center transition pointer-events-none",
              {
                "opacity-100": !hasBrowserView,
                "opacity-0": hasBrowserView,
              }
            )}
          >
            {showLoader ? (
              <WorkspaceLoadingIndicator variant="browser" status="loading" />
            ) : (
              <span className="text-sm text-neutral-500 dark:text-neutral-400 text-center px-4">
                {overlayMessage}
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
