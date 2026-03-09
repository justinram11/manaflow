import { WorkspaceLoadingIndicator } from "@/components/workspace-loading-indicator";
import {
  postApiProvidersAllocationsByAllocationIdJsonRpc,
  postApiProvidersAllocationsByAllocationIdEnsureDirect,
} from "@cmux/www-openapi-client";
import { getApiTaskRunsByIdOptions } from "@cmux/www-openapi-client/react-query";
import { useQuery as useRQ } from "@tanstack/react-query";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

export interface TaskRunSimulatorPaneProps {
  taskRunId: string;
}

export function TaskRunSimulatorPane({ taskRunId }: TaskRunSimulatorPaneProps) {
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
    iosProviderTailscaleHost?: string;
    iosVncPort?: number;
  } | null;
  const provider = vscodeInfo?.provider;
  const allocationId = vscodeInfo?.iosResourceAllocationId;
  const iosDirectToken =
    typeof vscodeInfo?.iosDirectToken === "string" ? vscodeInfo.iosDirectToken : null;
  const iosProviderBrowserBaseUrl =
    typeof vscodeInfo?.iosProviderBrowserBaseUrl === "string"
      ? vscodeInfo.iosProviderBrowserBaseUrl.replace(/\/$/, "")
      : null;
  const iosProviderTailscaleHost =
    typeof vscodeInfo?.iosProviderTailscaleHost === "string"
      ? vscodeInfo.iosProviderTailscaleHost
      : null;

  const hasCloudBackend = provider === "docker" || provider === "incus";

  const iosVncPort = vscodeInfo?.iosVncPort;
  const vncExternalUrl = useMemo(() => {
    if (!iosProviderTailscaleHost) return null;
    const port = iosVncPort ?? 5900;
    return `vnc://${iosProviderTailscaleHost}:${port}`;
  }, [iosProviderTailscaleHost, iosVncPort]);

  const directIngressBaseUrl = useMemo(() => {
    if (!iosProviderBrowserBaseUrl || !allocationId || !iosDirectToken) {
      return null;
    }

    return `${iosProviderBrowserBaseUrl}/allocations/${allocationId}`;
  }, [allocationId, iosDirectToken, iosProviderBrowserBaseUrl]);

  // Fetch screenshot via Authorization header (not query param) and convert to data URL
  const fetchDirectScreenshot = useCallback(async (): Promise<string | null> => {
    if (!directIngressBaseUrl || !iosDirectToken) {
      return null;
    }

    const url = new URL(`${directIngressBaseUrl}/screenshot`);
    url.searchParams.set("format", "png");
    const response = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${iosDirectToken}` },
    });
    if (!response.ok) return null;
    const blob = await response.blob();
    return URL.createObjectURL(blob);
  }, [directIngressBaseUrl, iosDirectToken]);

  const [controlError, setControlError] = useState<string | null>(null);
  const [controlStatus, setControlStatus] = useState<string | null>(null);
  const [isSendingControl, setIsSendingControl] = useState(false);
  const [textInput, setTextInput] = useState("");
  const [simulatorScreenshot, setSimulatorScreenshot] = useState<{
    src: string;
    mimeType: string;
  } | null>(null);

  const callSimulatorTool = useCallback(
    async (method: string, params: Record<string, unknown>) => {
      if (!allocationId) {
        throw new Error("Missing iOS resource allocation");
      }

      if (directIngressBaseUrl && iosDirectToken) {
        const url = new URL(`${directIngressBaseUrl}/tools-call`);
        const response = await fetch(url.toString(), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${iosDirectToken}`,
          },
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

  const ensureDirectBridge = useCallback(async () => {
    if (!allocationId || !iosDirectToken) return;
    try {
      await postApiProvidersAllocationsByAllocationIdEnsureDirect({
        path: { allocationId },
        body: { token: iosDirectToken },
      });
    } catch (error) {
      console.error("[simulator-controls] ensure-direct failed:", error);
    }
  }, [allocationId, iosDirectToken]);

  useEffect(() => {
    if (!allocationId) {
      return;
    }

    void ensureDirectBridge();
    void callSimulatorTool("ios_screen_info", {}).catch((error) => {
      console.error("[simulator-controls] failed to warm iOS allocation", error);
    });
  }, [allocationId, callSimulatorTool, ensureDirectBridge]);

  const refreshScreenshot = useCallback(async () => {
    if (!allocationId || screenshotRefreshInFlightRef.current) {
      return;
    }

    screenshotRefreshInFlightRef.current = true;
    try {
      // Try direct ingress fetch first (returns binary image via Authorization header)
      const objectUrl = await fetchDirectScreenshot();
      if (objectUrl) {
        // Revoke previous object URL to avoid memory leaks
        setSimulatorScreenshot((prev) => {
          if (prev?.src.startsWith("blob:")) {
            URL.revokeObjectURL(prev.src);
          }
          return { src: objectUrl, mimeType: "image/png" };
        });
        return;
      }

      // Fallback: call via MCP JSON-RPC
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
  }, [allocationId, callSimulatorTool, fetchDirectScreenshot]);

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

  const handleSendText = useCallback(async () => {
    const value = textInput.trim();
    if (!value) {
      return;
    }
    await runControl(`Typed "${value}"`, "ios_type_text", { text: value });
    setTextInput("");
  }, [runControl, textInput]);

  if (!hasCloudBackend) {
    return (
      <div className="flex grow flex-col items-center justify-center bg-neutral-50 dark:bg-black">
        <span className="px-4 text-center text-sm text-neutral-500 dark:text-neutral-400">
          iOS Simulator is only available in cloud mode with a Mac provider.
        </span>
      </div>
    );
  }

  if (!allocationId) {
    return (
      <div className="flex grow flex-col items-center justify-center bg-neutral-50 dark:bg-black">
        <WorkspaceLoadingIndicator variant="browser" status="loading" />
      </div>
    );
  }

  return (
    <div className="flex grow flex-col bg-neutral-50 dark:bg-black">
      <div className="flex min-h-0 grow flex-col border-l border-neutral-200 dark:border-neutral-800">
        {/* Screenshot preview */}
        <div className="relative flex min-h-0 grow items-center justify-center bg-black">
          {simulatorScreenshot ? (
            <img
              src={simulatorScreenshot.src}
              alt="iOS Simulator"
              className="max-h-full max-w-full object-contain"
            />
          ) : (
            <WorkspaceLoadingIndicator variant="browser" status="loading" />
          )}
        </div>

        {/* Controls bar */}
        <div className="flex flex-col gap-3 border-t border-neutral-200 bg-white p-3 dark:border-neutral-800 dark:bg-neutral-950">
          {/* External VNC link */}
          {vncExternalUrl ? (
            <div className="flex items-center gap-2">
              <a
                href={vncExternalUrl}
                className="inline-flex items-center gap-1.5 rounded-md bg-neutral-900 px-3 py-2 text-sm font-medium text-white hover:bg-neutral-800 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-200"
              >
                Open in VNC Client
              </a>
              <span className="text-xs text-neutral-500 dark:text-neutral-400">
                {iosProviderTailscaleHost}:{iosVncPort ?? 5900}
              </span>
            </div>
          ) : null}

          {/* Text input */}
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
              disabled={isSendingControl || textInput.trim().length === 0}
              className="rounded-md bg-neutral-900 px-3 py-2 text-sm text-white disabled:cursor-not-allowed disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900"
            >
              Send
            </button>
          </div>

          {/* Buttons */}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => {
                void runControl("Pressed Home", "ios_press_button", {
                  button: "home",
                });
              }}
              disabled={isSendingControl}
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
              disabled={isSendingControl}
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
              disabled={isSendingControl}
              className="flex-1 rounded-md border border-neutral-300 px-3 py-2 text-sm text-neutral-800 disabled:cursor-not-allowed disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-100"
            >
              Screenshot
            </button>
          </div>

          {/* Status messages */}
          {controlStatus ? (
            <div className="text-xs text-emerald-600 dark:text-emerald-400">
              {controlStatus}
            </div>
          ) : null}
          {controlError ? (
            <div className="text-xs text-red-600 dark:text-red-400">
              {controlError}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
