import { WorkspaceLoadingIndicator } from "@/components/workspace-loading-indicator";
import { toIosVncWebsocketUrl } from "@/lib/toProxyWorkspaceUrl";
import { postApiProvidersAllocationsByAllocationIdJsonRpc } from "@cmux/www-openapi-client";
import { getApiTaskRunsByIdOptions } from "@cmux/www-openapi-client/react-query";
import {
  VncViewer,
  type VncConnectionStatus,
  type VncViewerHandle,
} from "@cmux/shared/components/vnc-viewer";
import { useQuery as useRQ } from "@tanstack/react-query";
import clsx from "clsx";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";

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

export interface TaskRunSimulatorPaneProps {
  taskRunId: string;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

export function TaskRunSimulatorPane({ taskRunId }: TaskRunSimulatorPaneProps) {
  const viewerRef = useRef<VncViewerHandle>(null);
  const screenshotRef = useRef<HTMLImageElement | null>(null);
  const pointerGestureRef = useRef<PointerGesture | null>(null);
  const rpcCounterRef = useRef(0);
  const screenshotRefreshInFlightRef = useRef(false);

  const taskRunQuery = useRQ({
    ...getApiTaskRunsByIdOptions({ path: { id: taskRunId } }),
    enabled: Boolean(taskRunId),
  });
  const taskRun = taskRunQuery.data;

  const vscodeInfo = (taskRun?.vscode ?? null) as {
    url?: string;
    workspaceUrl?: string;
    provider?: string;
    ports?: Record<string, unknown>;
    iosResourceAllocationId?: string;
    iosDirectToken?: string;
    iosProviderBrowserBaseUrl?: string;
    iosProviderHostname?: string;
    iosProviderVncPort?: number | string;
  } | null;
  const rawUrl = vscodeInfo?.url ?? vscodeInfo?.workspaceUrl ?? null;
  const provider = vscodeInfo?.provider;
  const ports = vscodeInfo?.ports;
  const allocationId = vscodeInfo?.iosResourceAllocationId;
  const iosDirectToken =
    typeof vscodeInfo?.iosDirectToken === "string" ? vscodeInfo.iosDirectToken : null;
  const iosProviderBrowserBaseUrl =
    typeof vscodeInfo?.iosProviderBrowserBaseUrl === "string"
      ? vscodeInfo.iosProviderBrowserBaseUrl.replace(/\/$/, "")
      : null;
  const iosProviderHostname = vscodeInfo?.iosProviderHostname;
  const iosProviderVncPort =
    typeof vscodeInfo?.iosProviderVncPort === "number" ||
    typeof vscodeInfo?.iosProviderVncPort === "string"
      ? String(vscodeInfo.iosProviderVncPort)
      : null;

  const directIngressBaseUrl = useMemo(() => {
    if (!iosProviderBrowserBaseUrl || !allocationId || !iosDirectToken) {
      return null;
    }

    return `${iosProviderBrowserBaseUrl}/allocations/${allocationId}`;
  }, [allocationId, iosDirectToken, iosProviderBrowserBaseUrl]);

  const directScreenshotUrl = useMemo(() => {
    if (!directIngressBaseUrl || !iosDirectToken) {
      return null;
    }

    const url = new URL(`${directIngressBaseUrl}/screenshot`);
    url.searchParams.set("token", iosDirectToken);
    url.searchParams.set("format", "png");
    return url.toString();
  }, [directIngressBaseUrl, iosDirectToken]);

  const vncWebsocketUrl = useMemo(() => {
    if (directIngressBaseUrl && iosDirectToken) {
      const url = new URL(`${directIngressBaseUrl}/websockify`);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      url.searchParams.set("token", iosDirectToken);
      return url.toString();
    }
    if (iosProviderHostname && iosProviderVncPort) {
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      return `${protocol}//${iosProviderHostname}:${iosProviderVncPort}/websockify`;
    }
    if (!rawUrl || !provider) {
      return null;
    }
    return toIosVncWebsocketUrl(rawUrl, provider, ports ?? undefined);
  }, [
    directIngressBaseUrl,
    iosDirectToken,
    iosProviderHostname,
    iosProviderVncPort,
    rawUrl,
    provider,
    ports,
  ]);

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
  const [preferScreenshotMode, setPreferScreenshotMode] = useState(false);

  useEffect(() => {
    setPreferScreenshotMode(!window.isSecureContext);
  }, []);

  const shouldAttemptLiveVnc = Boolean(vncWebsocketUrl) && !preferScreenshotMode;
  const canUseLiveInput = shouldAttemptLiveVnc && vncStatus === "connected";
  const fallbackScreenshot =
    simulatorScreenshot && (!shouldAttemptLiveVnc || vncStatus !== "connected")
      ? simulatorScreenshot
      : null;
  const hasInteractiveSurface = canUseLiveInput || Boolean(fallbackScreenshot);
  const isUsingScreenshotFallback = Boolean(fallbackScreenshot);
  const canUseFallbackPointerInput = false;

  const overlayMessage = useMemo(() => {
    if (!hasCloudBackend) {
      return "iOS Simulator is only available in cloud mode with a Mac provider.";
    }
    if (!allocationId) {
      return "Waiting for the iOS simulator to start...";
    }
    if (preferScreenshotMode) {
      return "This page is using screenshot fallback on insecure HTTP.";
    }
    if (!hasSimulatorView) {
      return "Waiting for the iOS simulator to start...";
    }
    if (vncStatus === "error" && fallbackScreenshot) {
      return "Live stream unavailable. Using screenshot fallback.";
    }
    return "Connecting to iOS simulator...";
  }, [
    allocationId,
    fallbackScreenshot,
    hasCloudBackend,
    hasSimulatorView,
    preferScreenshotMode,
    vncStatus,
  ]);

  const callSimulatorTool = useCallback(
    async (method: string, params: Record<string, unknown>) => {
      if (!allocationId) {
        throw new Error("Missing iOS resource allocation");
      }

      if (directIngressBaseUrl && iosDirectToken) {
        const url = new URL(`${directIngressBaseUrl}/tools-call`);
        url.searchParams.set("token", iosDirectToken);
        const response = await fetch(url.toString(), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: method,
            arguments: params,
          }),
        });

        const payload = (await response.json()) as {
          result?: unknown;
          error?: string;
        };
        if (!response.ok) {
          throw new Error(payload.error ?? `Simulator request failed (${response.status})`);
        }
        if (payload.error) {
          throw new Error(payload.error);
        }
        return payload.result;
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
    [allocationId, directIngressBaseUrl, iosDirectToken, taskRunId]
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

    if (directScreenshotUrl) {
      setSimulatorScreenshot({
        src: `${directScreenshotUrl}&ts=${Date.now()}`,
        mimeType: "image/png",
      });
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
  }, [allocationId, callSimulatorTool, directScreenshotUrl]);

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
    async (label: string, method: string, params: Record<string, unknown>) => {
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

  const getScreenshotPoint = useCallback((clientX: number, clientY: number) => {
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
      if (!allocationId || !fallbackScreenshot) {
        return;
      }

      const point = getScreenshotPoint(event.clientX, event.clientY);
      if (!point) {
        return;
      }

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
    [allocationId, fallbackScreenshot, getScreenshotPoint]
  );

  const handlePointerUp = useCallback(
    async (event: ReactPointerEvent<HTMLDivElement>) => {
      const gesture = pointerGestureRef.current;
      pointerGestureRef.current = null;
      if (!gesture || gesture.pointerId !== event.pointerId) {
        return;
      }

      const endPoint = getScreenshotPoint(event.clientX, event.clientY);
      if (!endPoint) {
        return;
      }

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
    [getScreenshotPoint, runControl]
  );

  const clearPointerGesture = useCallback(() => {
    pointerGestureRef.current = null;
  }, []);

  const handleSendText = useCallback(async () => {
    const value = textInput.trim();
    if (!value) {
      return;
    }
    await runControl(`Typed "${value}"`, "ios_type_text", { text: value });
    setTextInput("");
  }, [runControl, textInput]);

  const onConnect = useCallback(() => {
    console.log(`Simulator VNC connected for task run ${taskRunId}`);
    viewerRef.current?.focus();
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

  const canControlSimulator = Boolean(allocationId) && hasInteractiveSurface;
  const isSimulatorBusy = !hasInteractiveSurface;

  return (
    <div className="flex grow flex-col bg-neutral-50 dark:bg-black">
      <div className="flex min-h-0 grow flex-col border-l border-neutral-200 dark:border-neutral-800">
        <div className="relative flex min-h-0 grow flex-row" aria-busy={isSimulatorBusy}>
          {shouldAttemptLiveVnc && vncWebsocketUrl ? (
            <VncViewer
              ref={viewerRef}
              url={vncWebsocketUrl}
              className={clsx("grow", {
                "opacity-0": vncStatus !== "connected" && Boolean(fallbackScreenshot),
              })}
              background="#000000"
              scaleViewport
              autoConnect
              autoReconnect
              reconnectDelay={1000}
              maxReconnectDelay={30000}
              focusOnClick
              viewOnly={false}
              onConnect={onConnect}
              onDisconnect={onDisconnect}
              onStatusChange={setVncStatus}
              loadingFallback={loadingFallback}
              errorFallback={errorFallback}
            />
          ) : (
            <div className="grow" />
          )}

          {fallbackScreenshot ? (
            <div className="absolute inset-0 flex items-center justify-center bg-black">
              <img
                ref={screenshotRef}
                src={fallbackScreenshot.src}
                alt="iOS Simulator"
                className="max-h-full max-w-full object-contain"
              />
            </div>
          ) : null}

          {fallbackScreenshot && canUseFallbackPointerInput ? (
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

          <div className="pointer-events-none absolute left-4 right-4 top-4 z-10 flex items-start justify-between gap-4">
            <div className="pointer-events-auto rounded-md border border-neutral-200/70 bg-white/90 px-3 py-2 text-xs text-neutral-700 shadow-sm backdrop-blur dark:border-neutral-800/70 dark:bg-neutral-950/90 dark:text-neutral-200">
              <div className="font-medium">Simulator controls</div>
              <div className="mt-1 text-neutral-500 dark:text-neutral-400">
                {isUsingScreenshotFallback
                  ? "Live VNC is unavailable. Screenshot fallback is view-only."
                  : canUseLiveInput
                    ? "Use your mouse and keyboard directly in the simulator."
                    : "Connecting to live simulator stream..."}
              </div>
              <div className="mt-2 inline-flex rounded-full border border-neutral-200 px-2 py-0.5 text-[11px] font-medium dark:border-neutral-800">
                {canUseLiveInput
                  ? "Mode: Live VNC"
                  : isUsingScreenshotFallback
                    ? "Mode: Screenshot fallback"
                    : "Mode: Connecting"}
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
                  disabled={!allocationId || isSendingControl || textInput.trim().length === 0}
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
                  disabled={!allocationId || isSendingControl}
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
                  disabled={!allocationId || isSendingControl}
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
                  disabled={!allocationId || isSendingControl}
                  className="flex-1 rounded-md border border-neutral-300 px-3 py-2 text-sm text-neutral-800 disabled:cursor-not-allowed disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-100"
                >
                  Screenshot
                </button>
              </div>
            </div>
          </div>

          <div
            className={clsx(
              "pointer-events-none absolute inset-0 flex items-center justify-center transition",
              {
                "opacity-100": !hasInteractiveSurface,
                "opacity-0": hasInteractiveSurface,
              }
            )}
          >
            {showLoader ? (
              <WorkspaceLoadingIndicator variant="browser" status="loading" />
            ) : (
              <span className="px-4 text-center text-sm text-neutral-500 dark:text-neutral-400">
                {overlayMessage}
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
