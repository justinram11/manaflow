import { WorkspaceLoadingIndicator } from "@/components/workspace-loading-indicator";
import { getApiTaskRunsByIdOptions } from "@cmux/www-openapi-client/react-query";
import { useQuery as useRQ } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";

export interface TaskRunAndroidPaneProps {
  taskRunId: string;
}

export function TaskRunAndroidPane({ taskRunId }: TaskRunAndroidPaneProps) {
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

  // noVNC + websockify served by cmux-android-vnc-proxy inside the emulator
  // container on port 39384. autoconnect makes it open the session
  // immediately; resize=scale keeps the emulator framebuffer fitted to the
  // pane regardless of zoom.
  const vncEmbedUrl = useMemo(() => {
    if (!vmHostname) return null;
    return `http://${vmHostname}:39384/vnc.html?autoconnect=true&resize=scale`;
  }, [vmHostname]);

  const directVmBaseUrl = useMemo(() => {
    if (!androidVmMcpUrl || !allocationId || !androidDirectToken) {
      return null;
    }
    return `${androidVmMcpUrl}/allocations/${allocationId}`;
  }, [allocationId, androidDirectToken, androidVmMcpUrl]);

  const [controlError, setControlError] = useState<string | null>(null);
  const [controlStatus, setControlStatus] = useState<string | null>(null);
  const [isSendingControl, setIsSendingControl] = useState(false);
  const [textInput, setTextInput] = useState("");
  // Collapsed by default so the VNC frame uses the full panel height. The
  // toolbar pops open with the chevron when the user needs Home/Back/text.
  const [isControlsOpen, setIsControlsOpen] = useState(false);

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

  const runControl = useCallback(
    async (label: string, method: string, params: Record<string, unknown>) => {
      setIsSendingControl(true);
      setControlError(null);
      try {
        await callAndroidTool(method, params);
        setControlStatus(label);
      } catch (error) {
        console.error(`[android-controls] ${method} failed:`, error);
        setControlError(
          error instanceof Error ? error.message : "Android control failed",
        );
      } finally {
        setIsSendingControl(false);
      }
    },
    [callAndroidTool],
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

  if (!allocationId || !vncEmbedUrl) {
    return (
      <div className="flex grow flex-col items-center justify-center bg-neutral-50 dark:bg-black">
        <WorkspaceLoadingIndicator
          variant="browser"
          status="loading"
          loadingTitle="Booting Android emulator"
          loadingDescription="Allocating the emulator container and waiting for the VNC stream. This usually takes a minute."
        />
      </div>
    );
  }

  return (
    <div className="flex grow flex-col bg-neutral-50 dark:bg-black">
      <div className="flex min-h-0 grow flex-col border-l border-neutral-200 dark:border-neutral-800">
        {/* Inline noVNC view of the emulator framebuffer. */}
        <div className="relative flex min-h-0 grow bg-black">
          <iframe
            key={vncEmbedUrl}
            src={vncEmbedUrl}
            title="Android Emulator VNC"
            className="h-full w-full border-0"
            allow="clipboard-read; clipboard-write"
          />
        </div>

        {/* Collapsible controls. A single thin header is always shown so the
            user can pop the toolbar open; collapsed by default to give the
            emulator framebuffer maximum vertical space. */}
        <div className="flex flex-col border-t border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-950">
          <button
            type="button"
            onClick={() => setIsControlsOpen((v) => !v)}
            className="flex h-7 items-center justify-between px-2 text-xs text-neutral-500 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-900"
          >
            <span className="flex items-center gap-2">
              <span className="font-mono text-[10px]">{vmHostname}:39384</span>
              <a
                href={vncEmbedUrl}
                target="_blank"
                rel="noreferrer"
                onClick={(e) => e.stopPropagation()}
                className="rounded border border-neutral-300 px-1.5 py-0.5 text-[10px] hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-900"
              >
                ↗ new tab
              </a>
            </span>
            <span>{isControlsOpen ? "▾ hide controls" : "▸ controls"}</span>
          </button>
          {isControlsOpen ? (
            <div className="flex flex-col gap-2 p-2">
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
                  className="flex-1 rounded-md border border-neutral-300 bg-white px-2 py-1 text-xs text-neutral-900 outline-none ring-0 placeholder:text-neutral-400 focus:border-neutral-500 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100 dark:placeholder:text-neutral-500"
                />
                <button
                  type="button"
                  onClick={() => {
                    void handleSendText();
                  }}
                  disabled={isSendingControl || textInput.trim().length === 0}
                  className="rounded-md bg-neutral-900 px-2 py-1 text-xs text-white disabled:cursor-not-allowed disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900"
                >
                  Send
                </button>
                <button
                  type="button"
                  onClick={() => {
                    void runControl("Pressed Home", "android_key", { key: "home" });
                  }}
                  disabled={isSendingControl}
                  className="rounded-md border border-neutral-300 px-2 py-1 text-xs text-neutral-800 disabled:cursor-not-allowed disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-100"
                >
                  Home
                </button>
                <button
                  type="button"
                  onClick={() => {
                    void runControl("Pressed Back", "android_key", { key: "back" });
                  }}
                  disabled={isSendingControl}
                  className="rounded-md border border-neutral-300 px-2 py-1 text-xs text-neutral-800 disabled:cursor-not-allowed disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-100"
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
                  className="rounded-md border border-neutral-300 px-2 py-1 text-xs text-neutral-800 disabled:cursor-not-allowed disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-100"
                >
                  Recents
                </button>
              </div>
              {controlStatus ? (
                <div className="text-[11px] text-emerald-600 dark:text-emerald-400">
                  {controlStatus}
                </div>
              ) : null}
              {controlError ? (
                <div className="text-[11px] text-red-600 dark:text-red-400">
                  {controlError}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
