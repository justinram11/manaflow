import { WorkspaceLoadingIndicator } from "@/components/workspace-loading-indicator";
import { getApiTaskRunsByIdOptions } from "@cmux/www-openapi-client/react-query";
import { useQuery as useRQ } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export interface TaskRunAndroidPaneProps {
  taskRunId: string;
}

export function TaskRunAndroidPane({ taskRunId }: TaskRunAndroidPaneProps) {
  const screenshotRefreshInFlightRef = useRef(false);

  const taskRunQuery = useRQ({
    ...getApiTaskRunsByIdOptions({ path: { id: taskRunId } }),
    enabled: Boolean(taskRunId),
  });
  const taskRun = taskRunQuery.data;

  const vscodeInfo = (taskRun?.vscode ?? null) as {
    provider?: string;
    androidResourceAllocationId?: string;
    androidDirectToken?: string;
    androidVmMcpUrl?: string;
  } | null;
  const provider = vscodeInfo?.provider;
  const allocationId = vscodeInfo?.androidResourceAllocationId;
  const androidDirectToken =
    typeof vscodeInfo?.androidDirectToken === "string"
      ? vscodeInfo.androidDirectToken
      : null;
  const androidVmMcpUrl =
    typeof vscodeInfo?.androidVmMcpUrl === "string"
      ? vscodeInfo.androidVmMcpUrl.replace(/\/$/, "")
      : null;

  const hasCloudBackend = provider === "docker" || provider === "incus";

  const vmHostname = useMemo(() => {
    if (!androidVmMcpUrl) {
      return null;
    }
    try {
      return new URL(androidVmMcpUrl).hostname;
    } catch (error) {
      console.error("[android-controls] invalid VM MCP URL", error);
      return null;
    }
  }, [androidVmMcpUrl]);

  // The in-container VNC websocket proxy runs on 39384 (cmux-android-vnc-proxy).
  const vncUrl = useMemo(() => {
    if (!vmHostname) return null;
    return `http://${vmHostname}:39384/vnc.html`;
  }, [vmHostname]);

  const directVmBaseUrl = useMemo(() => {
    if (!androidVmMcpUrl || !allocationId || !androidDirectToken) {
      return null;
    }
    return `${androidVmMcpUrl}/allocations/${allocationId}`;
  }, [allocationId, androidDirectToken, androidVmMcpUrl]);

  const fetchDirectScreenshot = useCallback(async (): Promise<string | null> => {
    if (!directVmBaseUrl || !androidDirectToken) {
      return null;
    }
    const url = new URL(`${directVmBaseUrl}/screenshot`);
    url.searchParams.set("format", "png");
    const response = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${androidDirectToken}` },
    });
    if (!response.ok) return null;
    const blob = await response.blob();
    return URL.createObjectURL(blob);
  }, [directVmBaseUrl, androidDirectToken]);

  const [controlError, setControlError] = useState<string | null>(null);
  const [controlStatus, setControlStatus] = useState<string | null>(null);
  const [isSendingControl, setIsSendingControl] = useState(false);
  const [textInput, setTextInput] = useState("");
  const [androidScreenshot, setAndroidScreenshot] = useState<{
    src: string;
    mimeType: string;
  } | null>(null);

  const callAndroidTool = useCallback(
    async (method: string, params: Record<string, unknown>) => {
      if (!allocationId || !directVmBaseUrl || !androidDirectToken) {
        throw new Error("Missing Android resource allocation or direct connection info");
      }

      const url = new URL(`${directVmBaseUrl}/tools-call`);
      const response = await fetch(url.toString(), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${androidDirectToken}`,
        },
        body: JSON.stringify({ name: method, arguments: params }),
      });

      const payload = (await response.json()) as {
        result?: unknown;
        error?: string;
      };
      if (!response.ok) {
        throw new Error(payload.error ?? `Android request failed (${response.status})`);
      }
      if (payload.error) {
        throw new Error(payload.error);
      }
      return payload.result;
    },
    [allocationId, directVmBaseUrl, androidDirectToken],
  );

  useEffect(() => {
    if (!allocationId) {
      return;
    }
    // Warm the allocation: kicks off the emulator boot if it has not started.
    void callAndroidTool("android_boot", {}).catch((error) => {
      console.error("[android-controls] failed to warm Android allocation", error);
    });
  }, [allocationId, callAndroidTool]);

  const refreshScreenshot = useCallback(async () => {
    if (!allocationId || screenshotRefreshInFlightRef.current) {
      return;
    }

    screenshotRefreshInFlightRef.current = true;
    try {
      const objectUrl = await fetchDirectScreenshot();
      if (objectUrl) {
        setAndroidScreenshot((prev) => {
          if (prev?.src.startsWith("blob:")) {
            URL.revokeObjectURL(prev.src);
          }
          return { src: objectUrl, mimeType: "image/png" };
        });
        return;
      }

      const result = (await callAndroidTool("android_screenshot", {
        format: "png",
      })) as { image?: string; mimeType?: string };
      if (result.image) {
        setAndroidScreenshot({
          src: `data:${result.mimeType ?? "image/png"};base64,${result.image}`,
          mimeType: result.mimeType ?? "image/png",
        });
      }
    } catch (error) {
      console.error("[android-controls] screenshot refresh failed", error);
    } finally {
      screenshotRefreshInFlightRef.current = false;
    }
  }, [allocationId, callAndroidTool, fetchDirectScreenshot]);

  useEffect(() => {
    if (!allocationId) {
      setAndroidScreenshot(null);
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
        await callAndroidTool(method, params);
        setControlStatus(label);
        void refreshScreenshot();
      } catch (error) {
        console.error(`[android-controls] ${method} failed:`, error);
        setControlError(
          error instanceof Error ? error.message : "Android control failed",
        );
      } finally {
        setIsSendingControl(false);
      }
    },
    [callAndroidTool, refreshScreenshot],
  );

  const handleSendText = useCallback(async () => {
    const value = textInput.trim();
    if (!value) {
      return;
    }
    await runControl(`Typed "${value}"`, "android_text", { text: value });
    setTextInput("");
  }, [runControl, textInput]);

  if (!hasCloudBackend) {
    return (
      <div className="flex grow flex-col items-center justify-center bg-neutral-50 dark:bg-black">
        <span className="px-4 text-center text-sm text-neutral-500 dark:text-neutral-400">
          The Android emulator is only available in cloud mode with an Android
          resource provider.
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
          {androidScreenshot ? (
            <img
              src={androidScreenshot.src}
              alt="Android Emulator"
              className="max-h-full max-w-full object-contain"
            />
          ) : (
            <WorkspaceLoadingIndicator variant="browser" status="loading" />
          )}
        </div>

        {/* Controls bar */}
        <div className="flex flex-col gap-3 border-t border-neutral-200 bg-white p-3 dark:border-neutral-800 dark:bg-neutral-950">
          {/* VNC link */}
          {vncUrl ? (
            <div className="flex items-center gap-2">
              <a
                href={vncUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 rounded-md bg-neutral-900 px-3 py-2 text-sm font-medium text-white hover:bg-neutral-800 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-200"
              >
                Open VNC View
              </a>
              <span className="text-xs text-neutral-500 dark:text-neutral-400">
                {vmHostname}:39384
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
              placeholder="Type text into emulator"
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
                void runControl("Pressed Home", "android_key", { key: "home" });
              }}
              disabled={isSendingControl}
              className="flex-1 rounded-md border border-neutral-300 px-3 py-2 text-sm text-neutral-800 disabled:cursor-not-allowed disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-100"
            >
              Home
            </button>
            <button
              type="button"
              onClick={() => {
                void runControl("Pressed Back", "android_key", { key: "back" });
              }}
              disabled={isSendingControl}
              className="flex-1 rounded-md border border-neutral-300 px-3 py-2 text-sm text-neutral-800 disabled:cursor-not-allowed disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-100"
            >
              Back
            </button>
            <button
              type="button"
              onClick={() => {
                void runControl("Opened recents", "android_key", {
                  key: "app_switch",
                });
              }}
              disabled={isSendingControl}
              className="flex-1 rounded-md border border-neutral-300 px-3 py-2 text-sm text-neutral-800 disabled:cursor-not-allowed disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-100"
            >
              Recents
            </button>
            <button
              type="button"
              onClick={() => {
                void runControl("Took screenshot", "android_screenshot", {
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
