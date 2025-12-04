"use client";

import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  forwardRef,
  type CSSProperties,
  type ReactNode,
} from "react";
import RFB from "@novnc/novnc/lib/rfb";
import clsx from "clsx";

export type VncConnectionStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "error";

export interface VncViewerProps {
  /** WebSocket URL to connect to (wss:// or ws://) - should point to websockify endpoint */
  url: string;
  /** Additional CSS class for the container */
  className?: string;
  /** Inline styles for the container */
  style?: CSSProperties;
  /** Background color for the canvas container */
  background?: string;
  /** Scale the viewport to fit the container */
  scaleViewport?: boolean;
  /** Clip the viewport to the container bounds */
  clipViewport?: boolean;
  /** Allow dragging the viewport when clipped */
  dragViewport?: boolean;
  /** Resize the remote session to match container size */
  resizeSession?: boolean;
  /** View-only mode (no keyboard/mouse input) */
  viewOnly?: boolean;
  /** Show dot cursor when remote cursor is hidden */
  showDotCursor?: boolean;
  /** JPEG quality level (0-9, higher is better quality) */
  qualityLevel?: number;
  /** Compression level (0-9, higher is more compression) */
  compressionLevel?: number;
  /** Auto-connect on mount */
  autoConnect?: boolean;
  /** Auto-reconnect on disconnect */
  autoReconnect?: boolean;
  /** Initial reconnect delay in ms */
  reconnectDelay?: number;
  /** Maximum reconnect delay in ms */
  maxReconnectDelay?: number;
  /** Maximum number of reconnect attempts (0 = infinite) */
  maxReconnectAttempts?: number;
  /** Focus the canvas on click */
  focusOnClick?: boolean;
  /** Loading fallback element */
  loadingFallback?: ReactNode;
  /** Error fallback element */
  errorFallback?: ReactNode;
  /** Called when connection is established */
  onConnect?: (rfb: RFB) => void;
  /** Called when connection is closed */
  onDisconnect?: (rfb: RFB | null, detail: { clean: boolean }) => void;
  /** Called when credentials are required */
  onCredentialsRequired?: (rfb: RFB) => void;
  /** Called when security failure occurs */
  onSecurityFailure?: (rfb: RFB | null, detail: { status: number; reason: string }) => void;
  /** Called when clipboard data is received from server */
  onClipboard?: (rfb: RFB, text: string) => void;
  /** Called when connection status changes */
  onStatusChange?: (status: VncConnectionStatus) => void;
  /** Called when desktop name is received */
  onDesktopName?: (rfb: RFB, name: string) => void;
  /** Called when capabilities are received */
  onCapabilities?: (rfb: RFB, capabilities: Record<string, boolean>) => void;
}

export interface VncViewerHandle {
  /** Connect to the VNC server */
  connect: () => void;
  /** Disconnect from the VNC server */
  disconnect: () => void;
  /** Get current connection status */
  getStatus: () => VncConnectionStatus;
  /** Check if currently connected */
  isConnected: () => boolean;
  /** Send clipboard text to remote server */
  clipboardPaste: (text: string) => void;
  /** Send Ctrl+Alt+Del */
  sendCtrlAltDel: () => void;
  /** Send a key event */
  sendKey: (keysym: number, code: string, down?: boolean) => void;
  /** Focus the VNC canvas */
  focus: () => void;
  /** Blur the VNC canvas */
  blur: () => void;
  /** Get the underlying RFB instance */
  getRfb: () => RFB | null;
  /** Machine power actions */
  machineShutdown: () => void;
  machineReboot: () => void;
  machineReset: () => void;
}

/**
 * VncViewer - A React component for connecting to VNC servers via websockify
 *
 * Features:
 * - Auto-connect and auto-reconnect with exponential backoff
 * - Full clipboard support (Cmd+V paste)
 * - Keyboard and mouse input
 * - Viewport scaling and resizing
 */
export const VncViewer = forwardRef<VncViewerHandle, VncViewerProps>(
  function VncViewer(
    {
      url,
      className,
      style,
      background = "#000000",
      scaleViewport = true,
      clipViewport = false,
      dragViewport = false,
      resizeSession = false,
      viewOnly = false,
      showDotCursor = false,
      qualityLevel = 6,
      compressionLevel = 2,
      autoConnect = true,
      autoReconnect = true,
      reconnectDelay = 1000,
      maxReconnectDelay = 30000,
      maxReconnectAttempts = 0,
      focusOnClick = true,
      loadingFallback,
      errorFallback,
      onConnect,
      onDisconnect,
      onCredentialsRequired,
      onSecurityFailure,
      onClipboard,
      onStatusChange,
      onDesktopName,
      onCapabilities,
    },
    ref
  ) {
    const containerRef = useRef<HTMLDivElement>(null);
    const rfbRef = useRef<RFB | null>(null);
    const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const reconnectAttemptsRef = useRef(0);
    const currentReconnectDelayRef = useRef(reconnectDelay);
    const isUnmountedRef = useRef(false);
    const urlRef = useRef(url);
    const shouldReconnectRef = useRef(autoReconnect);
    const connectInternalRef = useRef<(() => void) | null>(null);

    const [status, setStatus] = useState<VncConnectionStatus>("disconnected");

    // Keep urlRef updated
    useEffect(() => {
      urlRef.current = url;
    }, [url]);

    // Keep shouldReconnectRef updated
    useEffect(() => {
      shouldReconnectRef.current = autoReconnect;
    }, [autoReconnect]);

    // Update status and notify
    const updateStatus = useCallback(
      (newStatus: VncConnectionStatus) => {
        setStatus(newStatus);
        onStatusChange?.(newStatus);
      },
      [onStatusChange]
    );

    // Clear reconnect timer
    const clearReconnectTimer = useCallback(() => {
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
    }, []);

    // Schedule reconnect with exponential backoff
    const scheduleReconnect = useCallback(() => {
      if (isUnmountedRef.current || !shouldReconnectRef.current) {
        return;
      }

      // Check max attempts
      if (
        maxReconnectAttempts > 0 &&
        reconnectAttemptsRef.current >= maxReconnectAttempts
      ) {
        console.log(
          `[VncViewer] Max reconnect attempts (${maxReconnectAttempts}) reached`
        );
        updateStatus("error");
        return;
      }

      clearReconnectTimer();

      const delay = currentReconnectDelayRef.current;
      console.log(
        `[VncViewer] Scheduling reconnect in ${delay}ms (attempt ${reconnectAttemptsRef.current + 1})`
      );

      reconnectTimerRef.current = setTimeout(() => {
        if (isUnmountedRef.current) return;
        reconnectAttemptsRef.current++;
        // Exponential backoff
        currentReconnectDelayRef.current = Math.min(
          currentReconnectDelayRef.current * 2,
          maxReconnectDelay
        );
        connectInternalRef.current?.();
      }, delay);
    }, [clearReconnectTimer, maxReconnectAttempts, maxReconnectDelay, updateStatus]);

    // Internal connect function
    const connectInternal = useCallback(() => {
      if (isUnmountedRef.current) return;
      if (!containerRef.current) {
        console.warn("[VncViewer] Container not available for connection");
        return;
      }

      // Clean up existing connection
      if (rfbRef.current) {
        try {
          rfbRef.current.disconnect();
        } catch (e) {
          console.error("[VncViewer] Error disconnecting existing RFB:", e);
        }
        rfbRef.current = null;
      }

      updateStatus("connecting");

      try {
        const wsUrl = urlRef.current;
        console.log(`[VncViewer] Connecting to ${wsUrl}`);

        const rfb = new RFB(containerRef.current, wsUrl, {
          credentials: undefined,
          wsProtocols: ["binary"],
        });

        // Configure RFB options
        rfb.scaleViewport = scaleViewport;
        rfb.clipViewport = clipViewport;
        rfb.dragViewport = dragViewport;
        rfb.resizeSession = resizeSession;
        rfb.viewOnly = viewOnly;
        rfb.showDotCursor = showDotCursor;
        rfb.qualityLevel = qualityLevel;
        rfb.compressionLevel = compressionLevel;

        // Event handlers
        rfb.addEventListener("connect", () => {
          if (isUnmountedRef.current) return;
          console.log("[VncViewer] Connected");
          // Reset reconnect state on successful connection
          reconnectAttemptsRef.current = 0;
          currentReconnectDelayRef.current = reconnectDelay;
          updateStatus("connected");
          onConnect?.(rfb);
        });

        rfb.addEventListener("disconnect", (e) => {
          if (isUnmountedRef.current) return;
          const detail = (e as CustomEvent<{ clean: boolean }>).detail;
          console.log(
            `[VncViewer] Disconnected (clean: ${detail?.clean ?? false})`
          );
          rfbRef.current = null;
          updateStatus("disconnected");
          onDisconnect?.(rfb, detail ?? { clean: false });

          // Auto-reconnect on non-clean disconnect
          if (!detail?.clean && shouldReconnectRef.current) {
            scheduleReconnect();
          }
        });

        rfb.addEventListener("credentialsrequired", () => {
          if (isUnmountedRef.current) return;
          console.log("[VncViewer] Credentials required");
          onCredentialsRequired?.(rfb);
        });

        rfb.addEventListener("securityfailure", (e) => {
          if (isUnmountedRef.current) return;
          const detail = (
            e as CustomEvent<{ status: number; reason: string }>
          ).detail;
          console.error("[VncViewer] Security failure:", detail);
          updateStatus("error");
          onSecurityFailure?.(rfb, detail ?? { status: 0, reason: "Unknown" });
        });

        rfb.addEventListener("clipboard", (e) => {
          if (isUnmountedRef.current) return;
          const detail = (e as CustomEvent<{ text: string }>).detail;
          onClipboard?.(rfb, detail?.text ?? "");
        });

        rfb.addEventListener("desktopname", (e) => {
          if (isUnmountedRef.current) return;
          const detail = (e as CustomEvent<{ name: string }>).detail;
          onDesktopName?.(rfb, detail?.name ?? "");
        });

        rfb.addEventListener("capabilities", (e) => {
          if (isUnmountedRef.current) return;
          const detail = (
            e as CustomEvent<{ capabilities: Record<string, boolean> }>
          ).detail;
          onCapabilities?.(rfb, detail?.capabilities ?? {});
        });

        rfbRef.current = rfb;
      } catch (error) {
        console.error("[VncViewer] Failed to create RFB connection:", error);
        updateStatus("error");
        if (shouldReconnectRef.current) {
          scheduleReconnect();
        }
      }
    }, [
      scaleViewport,
      clipViewport,
      dragViewport,
      resizeSession,
      viewOnly,
      showDotCursor,
      qualityLevel,
      compressionLevel,
      reconnectDelay,
      updateStatus,
      scheduleReconnect,
      onConnect,
      onDisconnect,
      onCredentialsRequired,
      onSecurityFailure,
      onClipboard,
      onDesktopName,
      onCapabilities,
    ]);

    // Keep connectInternalRef updated
    useEffect(() => {
      connectInternalRef.current = connectInternal;
    }, [connectInternal]);

    // Public connect method
    const connect = useCallback(() => {
      clearReconnectTimer();
      reconnectAttemptsRef.current = 0;
      currentReconnectDelayRef.current = reconnectDelay;
      connectInternal();
    }, [clearReconnectTimer, reconnectDelay, connectInternal]);

    // Public disconnect method
    const disconnect = useCallback(() => {
      clearReconnectTimer();
      shouldReconnectRef.current = false; // Prevent auto-reconnect on explicit disconnect
      if (rfbRef.current) {
        try {
          rfbRef.current.disconnect();
        } catch (e) {
          console.error("[VncViewer] Error during disconnect:", e);
        }
        rfbRef.current = null;
      }
      updateStatus("disconnected");
    }, [clearReconnectTimer, updateStatus]);

    // Clipboard paste handler
    const clipboardPaste = useCallback((text: string) => {
      if (rfbRef.current) {
        try {
          rfbRef.current.clipboardPasteFrom(text);
        } catch (e) {
          console.error("[VncViewer] Error pasting to clipboard:", e);
        }
      }
    }, []);

    // Handle Cmd+V / Ctrl+V paste
    const handlePaste = useCallback(
      (e: ClipboardEvent) => {
        if (!rfbRef.current || viewOnly) return;

        // Get clipboard text
        const text = e.clipboardData?.getData("text");
        if (text) {
          e.preventDefault();
          clipboardPaste(text);
        }
      },
      [clipboardPaste, viewOnly]
    );

    // Handle keyboard shortcut for paste (Cmd+V / Ctrl+V)
    const handleKeyDown = useCallback(
      (e: KeyboardEvent) => {
        if (!rfbRef.current || viewOnly) return;

        // Check for Cmd+V (Mac) or Ctrl+V (Windows/Linux)
        if ((e.metaKey || e.ctrlKey) && e.key === "v") {
          e.preventDefault();
          e.stopPropagation();

          // Use async clipboard API
          navigator.clipboard.readText().then((text) => {
            if (text) {
              clipboardPaste(text);
            }
          }).catch((err) => {
            // Clipboard API might fail due to permissions
            console.warn("[VncViewer] Could not read clipboard:", err);
          });
        }
      },
      [clipboardPaste, viewOnly]
    );

    // Focus the canvas
    const focus = useCallback(() => {
      rfbRef.current?.focus();
    }, []);

    // Blur the canvas
    const blur = useCallback(() => {
      rfbRef.current?.blur();
    }, []);

    // Expose imperative handle
    useImperativeHandle(
      ref,
      () => ({
        connect,
        disconnect,
        getStatus: () => status,
        isConnected: () => status === "connected",
        clipboardPaste,
        sendCtrlAltDel: () => rfbRef.current?.sendCtrlAltDel(),
        sendKey: (keysym, code, down) =>
          rfbRef.current?.sendKey(keysym, code, down),
        focus,
        blur,
        getRfb: () => rfbRef.current,
        machineShutdown: () => rfbRef.current?.machineShutdown(),
        machineReboot: () => rfbRef.current?.machineReboot(),
        machineReset: () => rfbRef.current?.machineReset(),
      }),
      [connect, disconnect, status, clipboardPaste, focus, blur]
    );

    // Auto-connect on mount
    useEffect(() => {
      isUnmountedRef.current = false;

      if (autoConnect) {
        // Small delay to ensure DOM is ready
        const timer = setTimeout(() => {
          if (!isUnmountedRef.current) {
            connect();
          }
        }, 100);
        return () => clearTimeout(timer);
      }
      return undefined;
    }, [autoConnect, connect]);

    // Cleanup on unmount
    useEffect(() => {
      return () => {
        isUnmountedRef.current = true;
        clearReconnectTimer();
        if (rfbRef.current) {
          try {
            rfbRef.current.disconnect();
          } catch (e) {
            console.error("[VncViewer] Error during unmount cleanup:", e);
          }
          rfbRef.current = null;
        }
      };
    }, [clearReconnectTimer]);

    // Reconnect when URL changes
    useEffect(() => {
      if (status === "connected" || status === "connecting") {
        // URL changed, reconnect
        console.log("[VncViewer] URL changed, reconnecting...");
        connect();
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [url]);

    // Add paste event listeners
    useEffect(() => {
      const container = containerRef.current;
      if (!container) return;

      container.addEventListener("paste", handlePaste as EventListener);
      container.addEventListener("keydown", handleKeyDown as EventListener);

      return () => {
        container.removeEventListener("paste", handlePaste as EventListener);
        container.removeEventListener("keydown", handleKeyDown as EventListener);
      };
    }, [handlePaste, handleKeyDown]);

    // Handle container click for focus
    const handleContainerClick = useCallback(() => {
      if (focusOnClick && rfbRef.current) {
        focus();
      }
    }, [focusOnClick, focus]);

    // Compute what to render
    const showLoading = status === "connecting" || status === "disconnected";
    const showError = status === "error";

    // Default loading fallback
    const defaultLoadingFallback = useMemo(
      () => (
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="flex flex-col items-center gap-2">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-neutral-400 border-t-transparent" />
            <span className="text-sm text-neutral-400">
              {status === "connecting"
                ? "Connecting to remote desktop..."
                : "Waiting for connection..."}
            </span>
          </div>
        </div>
      ),
      [status]
    );

    // Default error fallback
    const defaultErrorFallback = useMemo(
      () => (
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="flex flex-col items-center gap-2">
            <span className="text-sm text-red-400">
              Failed to connect to remote desktop
            </span>
            <button
              type="button"
              onClick={connect}
              className="mt-2 rounded-md bg-neutral-800 px-3 py-1.5 text-sm text-white hover:bg-neutral-700"
            >
              Retry
            </button>
          </div>
        </div>
      ),
      [connect]
    );

    return (
      <div
        className={clsx("relative overflow-hidden", className)}
        style={{ background, ...style }}
        onClick={handleContainerClick}
      >
        {/* VNC Canvas Container */}
        <div
          ref={containerRef}
          className="absolute inset-0"
          style={{ background }}
          tabIndex={0}
        />

        {/* Loading Overlay */}
        {showLoading && (loadingFallback ?? defaultLoadingFallback)}

        {/* Error Overlay */}
        {showError && (errorFallback ?? defaultErrorFallback)}
      </div>
    );
  }
);

export default VncViewer;
