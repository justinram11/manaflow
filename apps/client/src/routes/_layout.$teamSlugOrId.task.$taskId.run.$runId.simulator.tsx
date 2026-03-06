import { WorkspaceLoadingIndicator } from "@/components/workspace-loading-indicator";
import { toIosVncWebsocketUrl } from "@/lib/toProxyWorkspaceUrl";
import { queryClient } from "@/query-client";
import {
  postApiProvidersAllocationsByAllocationIdJsonRpc,
} from "@cmux/www-openapi-client";
import {
  getApiTaskRunsByIdOptions,
} from "@cmux/www-openapi-client/react-query";
import {
  VncViewer,
  type VncConnectionStatus,
  type VncViewerHandle,
} from "@cmux/shared/components/vnc-viewer";
import { typedZid } from "@cmux/shared/utils/typed-zid";
import { useQuery as useRQ } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import clsx from "clsx";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import z from "zod";

const paramsSchema = z.object({
  taskId: typedZid("tasks"),
  runId: typedZid("taskRuns"),
});

const TAP_DISTANCE_PX = 12;
const MIN_SWIPE_SECONDS = 0.05;
const MAX_SWIPE_SECONDS = 2;

type PointerGesture = {
  pointerId: number;
  startClientX: number;
  startClientY: number;
  startX: number;
  startY: number;
  startedAt: number;
};

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

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
  const { runId: taskRunId, teamSlugOrId } = Route.useParams();
  const viewerRef = useRef<VncViewerHandle>(null);
  const screenshotRef = useRef<HTMLImageElement | null>(null);
  const pointerGestureRef = useRef<PointerGesture | null>(null);
  const rpcCounterRef = useRef(0);
  const screenshotRefreshInFlightRef = useRef(false);

  const taskRunQuery = useRQ({
    ...getApiTaskRunsByIdOptions({ path: { id: taskRunId } }),
    enabled: Boolean(teamSlugOrId && taskRunId),
  });
  const taskRun = taskRunQuery.data;

  const vscodeInfo = (taskRun?.vscode ?? null) as {
    url?: string;
    workspaceUrl?: string;
    provider?: string;
    ports?: Record<string, unknown>;
    iosResourceAllocationId?: string;
  } | null;
  const rawUrl = vscodeInfo?.url ?? vscodeInfo?.workspaceUrl ?? null;
  const provider = vscodeInfo?.provider;
  const ports = vscodeInfo?.ports;
  const allocationId = vscodeInfo?.iosResourceAllocationId;

  const vncWebsocketUrl = useMemo(() => {
    if (!rawUrl || !provider) {
      return null;
    }
    return toIosVncWebsocketUrl(rawUrl, provider, ports ?? undefined);
  }, [rawUrl, provider, ports]);

  const hasSimulatorView = Boolean(vncWebsocketUrl);
  const hasCloudBackend = provider === "docker" || provider === "incus";
  const showLoader = hasCloudBackend && !hasSimulatorView;

  const [vncStatus, setVncStatus] = useState<VncConnectionStatus>("disconnected");
  const [controlError, setControlError] = useState<string | null>(null);
  const [controlStatus, setControlStatus] = useState<string | null>(null);
  const [isSendingControl, setIsSendingControl] = useState(false);
  const [textInput, setTextInput] = useState("");
  const [simulatorScreenshot, setSimulatorScreenshot] = useState<{
    src: string;
    mimeType: string;
  } | null>(null);

  const overlayMessage = useMemo(() => {
    if (!hasCloudBackend) {
      return "iOS Simulator is only available in cloud mode with a Mac provider.";
    }
    if (!hasSimulatorView) {
      return "Waiting for the iOS simulator to start...";
    }
    return "Connecting to iOS simulator...";
  }, [hasSimulatorView, hasCloudBackend]);

  const callSimulatorTool = useCallback(
    async (method: string, params: Record<string, unknown>) => {
      if (!allocationId) {
        throw new Error("Missing iOS resource allocation");
      }

      const rpcId = `sim-${taskRunId}-${rpcCounterRef.current++}`;
      const response = await postApiProvidersAllocationsByAllocationIdJsonRpc({
        path: { allocationId },
        body: {
          jsonrpc: "2.0",
          method: "tools/call",
          params: {
            name: method,
            arguments: params,
          },
          id: rpcId,
        },
      });

      const payload = response.data;
      if (!payload) {
        throw new Error("Empty JSON-RPC response from simulator provider");
      }
      if (payload.error) {
        throw new Error(payload.error.message);
      }

      const result = payload.result;
      if (
        result &&
        typeof result === "object" &&
        "content" in result &&
        Array.isArray(result.content)
      ) {
        const textItem = result.content.find(
          (item): item is { text: string } =>
            Boolean(item) &&
            typeof item === "object" &&
            "type" in item &&
            item.type === "text" &&
            "text" in item &&
            typeof item.text === "string"
        );

        if (textItem) {
          const parsed = JSON.parse(textItem.text) as {
            success?: boolean;
            error?: string;
          };
          if (parsed.error) {
            throw new Error(parsed.error);
          }
          return parsed;
        }
      }

      return result;
    },
    [allocationId, taskRunId]
  );

  useEffect(() => {
    if (!allocationId) {
      return;
    }

    void callSimulatorTool("ios_screen_info", {}).catch((error) => {
      console.error("[simulator-controls] failed to warm iOS allocation", error);
    });
  }, [allocationId, callSimulatorTool]);

  const refreshScreenshot = useCallback(async () => {
    if (!allocationId || screenshotRefreshInFlightRef.current) {
      return;
    }

    screenshotRefreshInFlightRef.current = true;
    try {
      const result = (await callSimulatorTool("ios_screenshot", {
        format: "png",
      })) as {
        image?: string;
        mimeType?: string;
      };
      if (result.image) {
        setSimulatorScreenshot({
          src: `data:${result.mimeType ?? "image/png"};base64,${result.image}`,
          mimeType: result.mimeType ?? "image/png",
        });
      }
    } catch (error) {
      console.error("[simulator-controls] screenshot refresh failed", error);
    } finally {
      screenshotRefreshInFlightRef.current = false;
    }
  }, [allocationId, callSimulatorTool]);

  useEffect(() => {
    if (!allocationId) {
      setSimulatorScreenshot(null);
      return;
    }

    void refreshScreenshot();
    const interval = window.setInterval(() => {
      void refreshScreenshot();
    }, 1500);

    return () => {
      window.clearInterval(interval);
    };
  }, [allocationId, refreshScreenshot]);

  const runControl = useCallback(
    async (
      label: string,
      method: string,
      params: Record<string, unknown>
    ) => {
      setIsSendingControl(true);
      setControlError(null);
      try {
        await callSimulatorTool(method, params);
        setControlStatus(label);
        void refreshScreenshot();
      } catch (error) {
        console.error(`[simulator-controls] ${method} failed:`, error);
        setControlError(
          error instanceof Error ? error.message : "Simulator control failed"
        );
      } finally {
        setIsSendingControl(false);
      }
    },
    [callSimulatorTool, refreshScreenshot]
  );

  const getRemotePoint = useCallback((clientX: number, clientY: number) => {
    const metrics = viewerRef.current?.getCanvasMetrics();
    if (metrics && metrics.cssWidth > 0 && metrics.cssHeight > 0) {
      const xRatio = (clientX - metrics.left) / metrics.cssWidth;
      const yRatio = (clientY - metrics.top) / metrics.cssHeight;
      if (xRatio < 0 || xRatio > 1 || yRatio < 0 || yRatio > 1) {
        return null;
      }

      return {
        x: Math.round(clamp(xRatio, 0, 1) * Math.max(metrics.pixelWidth - 1, 0)),
        y: Math.round(clamp(yRatio, 0, 1) * Math.max(metrics.pixelHeight - 1, 0)),
      };
    }

    const screenshot = screenshotRef.current;
    if (!screenshot) {
      return null;
    }

    const rect = screenshot.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return null;
    }

    const xRatio = (clientX - rect.left) / rect.width;
    const yRatio = (clientY - rect.top) / rect.height;
    if (xRatio < 0 || xRatio > 1 || yRatio < 0 || yRatio > 1) {
      return null;
    }

    return {
      x: Math.round(
        clamp(xRatio, 0, 1) * Math.max(screenshot.naturalWidth - 1, 0)
      ),
      y: Math.round(
        clamp(yRatio, 0, 1) * Math.max(screenshot.naturalHeight - 1, 0)
      ),
    };
  }, []);

  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!allocationId) return;
      if (vncStatus !== "connected" && !simulatorScreenshot) return;

      const point = getRemotePoint(event.clientX, event.clientY);
      if (!point) return;

      pointerGestureRef.current = {
        pointerId: event.pointerId,
        startClientX: event.clientX,
        startClientY: event.clientY,
        startX: point.x,
        startY: point.y,
        startedAt: performance.now(),
      };

      setControlError(null);
      setControlStatus(null);
      event.currentTarget.setPointerCapture(event.pointerId);
      event.preventDefault();
    },
    [allocationId, getRemotePoint, simulatorScreenshot, vncStatus]
  );

  const handlePointerUp = useCallback(
    async (event: ReactPointerEvent<HTMLDivElement>) => {
      const gesture = pointerGestureRef.current;
      pointerGestureRef.current = null;
      if (!gesture || gesture.pointerId !== event.pointerId) return;

      const endPoint = getRemotePoint(event.clientX, event.clientY);
      if (!endPoint) return;

      const distance = Math.hypot(
        event.clientX - gesture.startClientX,
        event.clientY - gesture.startClientY
      );
      const durationSeconds = clamp(
        (performance.now() - gesture.startedAt) / 1000,
        MIN_SWIPE_SECONDS,
        MAX_SWIPE_SECONDS
      );

      if (distance <= TAP_DISTANCE_PX) {
        await runControl("Tapped simulator", "ios_tap", {
          x: gesture.startX,
          y: gesture.startY,
        });
      } else {
        await runControl("Swiped simulator", "ios_swipe", {
          fromX: gesture.startX,
          fromY: gesture.startY,
          toX: endPoint.x,
          toY: endPoint.y,
          duration: Number(durationSeconds.toFixed(2)),
        });
      }

      event.preventDefault();
    },
    [getRemotePoint, runControl]
  );

  const clearPointerGesture = useCallback(() => {
    pointerGestureRef.current = null;
  }, []);

  const handleSendText = useCallback(async () => {
    const value = textInput.trim();
    if (!value) return;
    await runControl(`Typed "${value}"`, "ios_type_text", { text: value });
    setTextInput("");
  }, [runControl, textInput]);

  const onConnect = useCallback(() => {
    console.log(`Simulator VNC connected for task run ${taskRunId}`);
  }, [taskRunId]);

  const onDisconnect = useCallback(
    (_rfb: unknown, detail: { clean: boolean }) => {
      console.log(
        `Simulator VNC disconnected for task run ${taskRunId} (clean: ${detail.clean})`
      );
      clearPointerGesture();
    },
    [clearPointerGesture, taskRunId]
  );

  const loadingFallback = useMemo(
    () => <WorkspaceLoadingIndicator variant="browser" status="loading" />,
    []
  );
  const errorFallback = useMemo(
    () => <WorkspaceLoadingIndicator variant="browser" status="error" />,
    []
  );

  const hasInteractiveSurface =
    (hasSimulatorView && vncStatus === "connected") ||
    Boolean(simulatorScreenshot);
  const canControlSimulator = Boolean(allocationId) && hasInteractiveSurface;
  const isSimulatorBusy = !hasInteractiveSurface;

  return (
    <div className="flex flex-col grow bg-neutral-50 dark:bg-black">
      <div className="flex flex-col grow min-h-0 border-l border-neutral-200 dark:border-neutral-800">
        <div
          className="flex flex-row grow min-h-0 relative"
          aria-busy={isSimulatorBusy}
        >
          {vncWebsocketUrl ? (
            <VncViewer
              ref={viewerRef}
              url={vncWebsocketUrl}
              className={clsx("grow", {
                "opacity-0": vncStatus !== "connected" && Boolean(simulatorScreenshot),
              })}
              background="#000000"
              scaleViewport
              autoConnect
              autoReconnect
              reconnectDelay={1000}
              maxReconnectDelay={30000}
              focusOnClick={false}
              viewOnly
              onConnect={onConnect}
              onDisconnect={onDisconnect}
              onStatusChange={setVncStatus}
              loadingFallback={loadingFallback}
              errorFallback={errorFallback}
            />
          ) : (
            <div className="grow" />
          )}

          {simulatorScreenshot && vncStatus !== "connected" ? (
            <div className="absolute inset-0 flex items-center justify-center bg-black">
              <img
                ref={screenshotRef}
                src={simulatorScreenshot.src}
                alt="iOS Simulator"
                className="max-h-full max-w-full object-contain"
              />
            </div>
          ) : null}

          {hasSimulatorView ? (
            <div
              className={clsx("absolute inset-0 touch-none", {
                "pointer-events-auto cursor-crosshair": canControlSimulator,
                "pointer-events-none": !canControlSimulator,
              })}
              onPointerDown={handlePointerDown}
              onPointerUp={(event) => {
                void handlePointerUp(event);
              }}
              onPointerCancel={clearPointerGesture}
              onPointerLeave={clearPointerGesture}
            />
          ) : null}

          <div className="absolute left-4 right-4 top-4 z-10 flex items-start justify-between gap-4 pointer-events-none">
            <div className="pointer-events-auto rounded-md border border-neutral-200/70 bg-white/90 px-3 py-2 text-xs text-neutral-700 shadow-sm backdrop-blur dark:border-neutral-800/70 dark:bg-neutral-950/90 dark:text-neutral-200">
              <div className="font-medium">Simulator controls</div>
              <div className="mt-1 text-neutral-500 dark:text-neutral-400">
                {vncStatus === "connected"
                  ? "Tap to click. Drag to swipe."
                  : "Tap to click. Drag to swipe. View is using live screenshots."}
              </div>
              {!allocationId ? (
                <div className="mt-2 text-amber-600 dark:text-amber-400">
                  Waiting for iOS allocation...
                </div>
              ) : null}
              {controlStatus ? (
                <div className="mt-2 text-emerald-600 dark:text-emerald-400">
                  {controlStatus}
                </div>
              ) : null}
              {controlError ? (
                <div className="mt-2 text-red-600 dark:text-red-400">
                  {controlError}
                </div>
              ) : null}
            </div>

            <div className="pointer-events-auto flex min-w-[18rem] flex-col gap-2 rounded-md border border-neutral-200/70 bg-white/90 p-3 shadow-sm backdrop-blur dark:border-neutral-800/70 dark:bg-neutral-950/90">
              <div className="flex gap-2">
                <input
                  type="text"
                  value={textInput}
                  onChange={(event) => setTextInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      void handleSendText();
                    }
                  }}
                  placeholder="Type text into simulator"
                  className="flex-1 rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 outline-none ring-0 placeholder:text-neutral-400 focus:border-neutral-500 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100 dark:placeholder:text-neutral-500"
                />
                <button
                  type="button"
                  onClick={() => {
                    void handleSendText();
                  }}
                  disabled={!canControlSimulator || isSendingControl || textInput.trim().length === 0}
                  className="rounded-md bg-neutral-900 px-3 py-2 text-sm text-white disabled:cursor-not-allowed disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900"
                >
                  Send
                </button>
              </div>

              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => {
                    void runControl("Pressed Home", "ios_press_button", {
                      button: "home",
                    });
                  }}
                  disabled={!canControlSimulator || isSendingControl}
                  className="flex-1 rounded-md border border-neutral-300 px-3 py-2 text-sm text-neutral-800 disabled:cursor-not-allowed disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-100"
                >
                  Home
                </button>
                <button
                  type="button"
                  onClick={() => {
                    void runControl("Pressed Lock", "ios_press_button", {
                      button: "lock",
                    });
                  }}
                  disabled={!canControlSimulator || isSendingControl}
                  className="flex-1 rounded-md border border-neutral-300 px-3 py-2 text-sm text-neutral-800 disabled:cursor-not-allowed disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-100"
                >
                  Lock
                </button>
                <button
                  type="button"
                  onClick={() => {
                    void runControl("Took screenshot", "ios_screenshot", {
                      format: "png",
                    });
                  }}
                  disabled={!canControlSimulator || isSendingControl}
                  className="flex-1 rounded-md border border-neutral-300 px-3 py-2 text-sm text-neutral-800 disabled:cursor-not-allowed disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-100"
                >
                  Screenshot
                </button>
              </div>
            </div>
          </div>

          <div
            className={clsx(
              "absolute inset-0 flex items-center justify-center transition pointer-events-none",
              {
                "opacity-100": !hasSimulatorView,
                "opacity-0": hasSimulatorView,
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
