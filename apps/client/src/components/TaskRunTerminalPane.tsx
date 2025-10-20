import { createTerminalOptions } from "@cmux/shared/terminal-config";
import { FitAddon } from "@xterm/addon-fit";
import { AttachAddon } from "@xterm/addon-attach";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, MonitorUp, RotateCw } from "lucide-react";

import { resolveWorkspaceServiceBases } from "@/lib/toProxyWorkspaceUrl";

const REQUIRED_PORT = 39383;
const TMUX_ATTACH_COMMAND = "tmux attach -t cmux || tmux new -s cmux";

type ConnectionStatus = "idle" | "connecting" | "connected" | "error";

interface TaskRunTerminalPaneProps {
  workspaceUrl: string | null;
}

export function TaskRunTerminalPane({ workspaceUrl }: TaskRunTerminalPaneProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const attachAddonRef = useRef<AttachAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  const [status, setStatus] = useState<ConnectionStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [retryCounter, setRetryCounter] = useState(0);

  const serviceBaseUrls = useMemo(() => {
    if (!workspaceUrl) {
      return [];
    }
    return resolveWorkspaceServiceBases(workspaceUrl, REQUIRED_PORT);
  }, [workspaceUrl]);

  const sendResize = useCallback(() => {
    const ws = wsRef.current;
    const terminal = terminalRef.current;
    if (!ws || !terminal) return;
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(
      JSON.stringify({
        type: "resize",
        cols: terminal.cols,
        rows: terminal.rows,
      }),
    );
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const terminal = new Terminal(
      createTerminalOptions({
        convertEol: true,
        cursorBlink: true,
        scrollback: 200_000,
        fontSize: 13,
      }),
    );
    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon();
    terminal.loadAddon(fitAddon);
    terminal.loadAddon(webLinksAddon);
    terminal.open(container);
    fitAddon.fit();
    terminal.focus();

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    const handleWindowResize = () => {
      fitAddon.fit();
      sendResize();
    };

    const resizeObserver = typeof ResizeObserver !== "undefined"
      ? new ResizeObserver(handleWindowResize)
      : null;
    resizeObserver?.observe(container);
    window.addEventListener("resize", handleWindowResize);

    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener("resize", handleWindowResize);
      attachAddonRef.current?.dispose();
      wsRef.current?.close();
      wsRef.current = null;
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, [sendResize]);

  useEffect(() => {
    if (!terminalRef.current) {
      setStatus(workspaceUrl ? "idle" : "idle");
      setError(null);
      return;
    }

    if (!workspaceUrl || serviceBaseUrls.length === 0) {
      setStatus("error");
      setError("Workspace terminal endpoint unavailable");
      return;
    }

    let cancelled = false;
    let tmuxReady = false;
    setStatus("connecting");
    setError(null);

    const cols = Math.max(terminalRef.current.cols || 120, 40);
    const rows = Math.max(terminalRef.current.rows || 32, 12);

    const controller = new AbortController();
    const signal = controller.signal;

    const createSession = async () => {
      const maxAttempts = 4;
      const baseDelayMs = 750;

      const lastIndex = serviceBaseUrls.length - 1;

      for (const [index, baseUrl] of serviceBaseUrls.entries()) {
        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
          try {
            const response = await fetch(`${baseUrl}/api/tabs`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                cmd: "/bin/bash",
                args: ["-lc", TMUX_ATTACH_COMMAND],
                cols,
                rows,
              }),
              signal,
            });

            if (!response.ok) {
              throw new Error(`Terminal request failed (${response.status})`);
            }

            const payload: { id: string; ws_url: string } = await response.json();
            if (cancelled) {
              return;
            }

          const socketUrl = new URL(baseUrl);
          socketUrl.protocol = socketUrl.protocol === "https:" ? "wss:" : "ws:";
          socketUrl.pathname = `/ws/${payload.id}`;
          socketUrl.search = "";
          socketUrl.hash = "";

          const socket = new WebSocket(socketUrl.toString());
          socket.binaryType = "arraybuffer";

          socket.addEventListener("open", () => {
            if (cancelled) return;
            // Don't mark as connected yet - wait for first message indicating tmux is ready
            fitAddonRef.current?.fit();
            sendResize();
          });

          socket.addEventListener("message", () => {
            if (cancelled || tmuxReady) return;
            // First message indicates tmux has attached and is ready
            tmuxReady = true;
            setStatus("connected");
          });

          socket.addEventListener("close", () => {
            if (cancelled) return;
            setStatus("error");
            setError("Terminal connection closed");
          });

          socket.addEventListener("error", () => {
            if (cancelled) return;
            setStatus("error");
            setError("Failed to connect to terminal");
          });

          const attachAddon = new AttachAddon(socket, { bidirectional: true });
          attachAddonRef.current = attachAddon;
          terminalRef.current?.loadAddon(attachAddon);
          wsRef.current = socket;
          return;
        } catch (err) {
          if (cancelled) return;

          if (attempt === maxAttempts) {
            // Try the next base URL if available
            if (index === lastIndex) {
              setStatus("error");
              setError(err instanceof Error ? err.message : String(err));
              return;
            }
          } else {
            const delay = baseDelayMs * attempt;
            await new Promise((resolve) => setTimeout(resolve, delay));
          }
          }
        }
      }
    };

    void createSession();

    return () => {
      cancelled = true;
      controller.abort();
      attachAddonRef.current?.dispose();
      attachAddonRef.current = null;
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [serviceBaseUrls, workspaceUrl, retryCounter, sendResize]);

  const handleRetry = useCallback(() => {
    setRetryCounter((value) => value + 1);
  }, []);

  if (!workspaceUrl) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-neutral-500 dark:text-neutral-400">
        <MonitorUp className="size-4" aria-hidden />
        <span>Terminal becomes available after the workspace starts.</span>
      </div>
    );
  }

  return (
    <div className="relative flex h-full flex-col">
      <div ref={containerRef} className="flex-1 bg-black" />
      {status !== "connected" ? (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/60">
          <div className="pointer-events-auto flex max-w-xs flex-col items-center gap-2 rounded-md bg-neutral-900/90 px-4 py-3 text-center text-sm text-neutral-200">
            {status === "connecting" ? (
              <span>Connecting to tmux session…</span>
            ) : (
              <div className="flex flex-col items-center gap-1">
                <AlertTriangle className="size-4 text-amber-400" aria-hidden />
                <span>Unable to connect to the tmux session.</span>
                {error ? (
                  <span className="text-xs text-neutral-400">{error}</span>
                ) : null}
                <button
                  type="button"
                  onClick={handleRetry}
                  className="mt-2 inline-flex items-center gap-1 rounded border border-neutral-700 px-3 py-1 text-xs text-neutral-200 hover:border-neutral-500 hover:text-neutral-50"
                >
                  <RotateCw className="size-3" aria-hidden />
                  Retry
                </button>
              </div>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
