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
import clsx from "clsx";
import { useNetwork } from "../hooks/use-network";

// RFB type definition (copied from @novnc/novnc types to avoid static imports)
// The actual module is dynamically imported to avoid top-level await issues
interface RFBOptions {
  credentials?: {
    username?: string;
    password?: string;
    target?: string;
  };
  wsProtocols?: string[];
}

interface RFBInstance {
  scaleViewport: boolean;
  clipViewport: boolean;
  dragViewport: boolean;
  resizeSession: boolean;
  viewOnly: boolean;
  showDotCursor: boolean;
  background: string;
  qualityLevel: number;
  compressionLevel: number;
  readonly capabilities: { power?: boolean };
  disconnect(): void;
  sendCredentials(credentials: { username?: string; password?: string; target?: string }): void;
  sendKey(keysym: number, code: string | null, down?: boolean): void;
  sendCtrlAltDel(): void;
  focus(options?: FocusOptions): void;
  blur(): void;
  clipboardPasteFrom(text: string): void;
  machineShutdown(): void;
  machineReboot(): void;
  machineReset(): void;
  addEventListener(type: string, listener: (event: CustomEvent) => void): void;
  removeEventListener(type: string, listener: (event: CustomEvent) => void): void;
}

interface RFBConstructor {
  new (target: HTMLElement, urlOrChannel: string | WebSocket, options?: RFBOptions): RFBInstance;
}

// Dynamically import RFB to avoid top-level await issues with noVNC
let RFBClass: RFBConstructor | null = null;
const loadRFB = async (): Promise<RFBConstructor> => {
  if (RFBClass) return RFBClass;
  // noVNC 1.7.0-beta exports from core/rfb.js via package.json "exports"
  // Type assertion since we have inline type definitions and don't need external @types/novnc__novnc
  const module = await import("@novnc/novnc") as { default: RFBConstructor };
  RFBClass = module.default;
  return RFBClass;
};

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
  onConnect?: (rfb: RFBInstance) => void;
  /** Called when connection is closed */
  onDisconnect?: (rfb: RFBInstance | null, detail: { clean: boolean }) => void;
  /** Called when credentials are required */
  onCredentialsRequired?: (rfb: RFBInstance) => void;
  /** Called when security failure occurs */
  onSecurityFailure?: (
    rfb: RFBInstance | null,
    detail: { status: number; reason: string }
  ) => void;
  /** Called when clipboard data is received from server */
  onClipboard?: (rfb: RFBInstance, text: string) => void;
  /** Called when connection status changes */
  onStatusChange?: (status: VncConnectionStatus) => void;
  /** Called when desktop name is received */
  onDesktopName?: (rfb: RFBInstance, name: string) => void;
  /** Called when capabilities are received */
  onCapabilities?: (rfb: RFBInstance, capabilities: Record<string, boolean>) => void;
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
  getRfb: () => RFBInstance | null;
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
    console.log("[VncViewer] Component rendering, url:", url);

    const containerRef = useRef<HTMLDivElement>(null);
    const rfbRef = useRef<RFBInstance | null>(null);
    const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
      null
    );
    const reconnectAttemptsRef = useRef(0);
    const currentReconnectDelayRef = useRef(reconnectDelay);
    const isUnmountedRef = useRef(false);
    const urlRef = useRef(url);
    const shouldReconnectRef = useRef(autoReconnect);
    const connectInternalRef = useRef<(() => Promise<void>) | null>(null);

    const [status, setStatus] = useState<VncConnectionStatus>("disconnected");
    const [errorMessage, setErrorMessage] = useState<string | null>(null);
    const [reconnectAttempt, setReconnectAttempt] = useState(0);
    const network = useNetwork();
    const isOffline = !network.online;

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
      (newStatus: VncConnectionStatus, error?: string) => {
        setStatus(newStatus);
        if (newStatus === "error") {
          setErrorMessage(error ?? "Connection failed");
        } else if (newStatus === "connected") {
          setErrorMessage(null);
          setReconnectAttempt(0);
        } else if (newStatus === "connecting") {
          // Keep error message during reconnect attempts for context
        }
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
    const scheduleReconnect = useCallback((error?: string) => {
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
        updateStatus("error", error ?? "Max reconnect attempts reached");
        return;
      }

      clearReconnectTimer();

      const delay = currentReconnectDelayRef.current;
      const nextAttempt = reconnectAttemptsRef.current + 1;
      console.log(
        `[VncViewer] Scheduling reconnect in ${delay}ms (attempt ${nextAttempt})`
      );

      reconnectTimerRef.current = setTimeout(() => {
        if (isUnmountedRef.current) return;
        reconnectAttemptsRef.current++;
        setReconnectAttempt(reconnectAttemptsRef.current);
        // Exponential backoff
        currentReconnectDelayRef.current = Math.min(
          currentReconnectDelayRef.current * 2,
          maxReconnectDelay
        );
        connectInternalRef.current?.();
      }, delay);
    }, [
      clearReconnectTimer,
      maxReconnectAttempts,
      maxReconnectDelay,
      updateStatus,
    ]);

    // Internal connect function
    const connectInternal = useCallback(async () => {
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
        // Dynamically load RFB class
        const RFB = await loadRFB();
        if (isUnmountedRef.current) return;

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
          const isClean = detail?.clean ?? false;
          console.log(
            `[VncViewer] Disconnected (clean: ${isClean})`
          );
          rfbRef.current = null;
          updateStatus("disconnected");
          onDisconnect?.(rfb, detail ?? { clean: false });

          // Auto-reconnect on non-clean disconnect
          if (!isClean && shouldReconnectRef.current) {
            scheduleReconnect("Connection lost unexpectedly");
          }
        });

        rfb.addEventListener("credentialsrequired", () => {
          if (isUnmountedRef.current) return;
          console.log("[VncViewer] Credentials required");
          onCredentialsRequired?.(rfb);
        });

        rfb.addEventListener("securityfailure", (e) => {
          if (isUnmountedRef.current) return;
          const detail = (e as CustomEvent<{ status: number; reason: string }>)
            .detail;
          console.error("[VncViewer] Security failure:", detail);
          updateStatus("error", detail?.reason ?? "Security failure");
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
        const errorMsg = error instanceof Error ? error.message : "Failed to connect";
        updateStatus("error", errorMsg);
        if (shouldReconnectRef.current) {
          scheduleReconnect(errorMsg);
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

    // Auto-reconnect when network comes back online
    const prevOnlineRef = useRef(network.online);
    useEffect(() => {
      if (network.online && !prevOnlineRef.current) {
        console.log("[VncViewer] Network back online, reconnecting...");
        if (status === "error" || status === "disconnected") {
          connect();
        }
      }
      prevOnlineRef.current = network.online;
    }, [network.online, status, connect]);

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

    // Clipboard paste handler - syncs clipboard then sends Ctrl+V
    // Uses proper DOM key codes for QEMU extended key events
    const clipboardPaste = useCallback((text: string) => {
      const rfb = rfbRef.current;
      if (!rfb) return;

      try {
        // Sync clipboard to VNC server
        rfb.clipboardPasteFrom(text);
        console.log("[VncViewer] Clipboard synced, sending Ctrl+V...");

        // X11 keysyms (same as noVNC's KeyTable)
        const XK_Meta_L = 0xffe7;
        const XK_Meta_R = 0xffe8;
        const XK_Super_L = 0xffeb;
        const XK_Super_R = 0xffec;
        const XK_Control_L = 0xffe3;
        const XK_v = 0x0076;

        // Small delay to ensure clipboard is processed by VNC server
        setTimeout(() => {
          // Release Meta/Super keys that might be held from user's Cmd
          // (noVNC sent Meta down before we intercepted the V keydown)
          rfb.sendKey(XK_Meta_L, "MetaLeft", false);
          rfb.sendKey(XK_Meta_R, "MetaRight", false);
          rfb.sendKey(XK_Super_L, "OSLeft", false);
          rfb.sendKey(XK_Super_R, "OSRight", false);

          // Send Ctrl+V with proper DOM codes (like noVNC's sendCtrlAltDel)
          rfb.sendKey(XK_Control_L, "ControlLeft", true);
          rfb.sendKey(XK_v, "KeyV", true);
          rfb.sendKey(XK_v, "KeyV", false);
          rfb.sendKey(XK_Control_L, "ControlLeft", false);
          console.log("[VncViewer] Ctrl+V sent");
        }, 50);
      } catch (e) {
        console.error("[VncViewer] Error pasting to clipboard:", e);
      }
    }, []);

    // Send a key combo to VNC, releasing Meta/Super first (for Mac Cmd → Linux Ctrl translation)
    const sendKeyCombo = useCallback((keysym: number, code: string, withShift = false) => {
      const rfb = rfbRef.current;
      if (!rfb) return;

      // X11 keysyms for modifiers
      const XK_Shift_L = 0xffe1;
      const XK_Meta_L = 0xffe7;
      const XK_Meta_R = 0xffe8;
      const XK_Super_L = 0xffeb;
      const XK_Super_R = 0xffec;
      const XK_Control_L = 0xffe3;

      // Release Meta/Super keys that might be held from user's Cmd
      rfb.sendKey(XK_Meta_L, "MetaLeft", false);
      rfb.sendKey(XK_Meta_R, "MetaRight", false);
      rfb.sendKey(XK_Super_L, "OSLeft", false);
      rfb.sendKey(XK_Super_R, "OSRight", false);

      // Send Ctrl+<key> (with optional Shift)
      rfb.sendKey(XK_Control_L, "ControlLeft", true);
      if (withShift) rfb.sendKey(XK_Shift_L, "ShiftLeft", true);
      rfb.sendKey(keysym, code, true);
      rfb.sendKey(keysym, code, false);
      if (withShift) rfb.sendKey(XK_Shift_L, "ShiftLeft", false);
      rfb.sendKey(XK_Control_L, "ControlLeft", false);
    }, []);

    // Check if VNC viewer is focused (container or any child including canvas)
    const isVncFocused = useCallback(() => {
      const container = containerRef.current;
      if (!container) return false;
      const active = document.activeElement;
      return container === active || container.contains(active);
    }, []);

    // Send Ctrl+key combo (releasing Meta first for Mac)
    const sendCtrlKey = useCallback((keysym: number, code: string, releaseMeta = false) => {
      const rfb = rfbRef.current;
      if (!rfb) return;

      const XK_Control_L = 0xffe3;

      if (releaseMeta) {
        // Release Meta/Super keys that might be held from user's Option key
        rfb.sendKey(0xffe7, "MetaLeft", false);
        rfb.sendKey(0xffe8, "MetaRight", false);
        rfb.sendKey(0xffeb, "OSLeft", false);
        rfb.sendKey(0xffec, "OSRight", false);
        // Also release Alt since Option maps to Alt
        rfb.sendKey(0xffe9, "AltLeft", false);
        rfb.sendKey(0xffea, "AltRight", false);
      }

      rfb.sendKey(XK_Control_L, "ControlLeft", true);
      rfb.sendKey(keysym, code, true);
      rfb.sendKey(keysym, code, false);
      rfb.sendKey(XK_Control_L, "ControlLeft", false);
    }, []);

    // Intercept Mac shortcuts and translate to Linux equivalents
    // Listen at document level to intercept before browser handles them
    useEffect(() => {
      const isMac = /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent);
      if (!isMac) return; // Only needed on Mac

      const handleKeyDown = async (e: KeyboardEvent) => {
        // Only handle if VNC is focused
        if (!isVncFocused()) return;

        const rfb = rfbRef.current;
        const code = e.code; // Use e.code for reliable key identification

        // Helper to handle a shortcut: preventDefault first, then send to VNC
        const handleShortcut = (
          logMsg: string,
          action: () => void
        ) => {
          e.preventDefault();
          e.stopPropagation();
          if (!rfb) {
            console.log(`[VncViewer] ${logMsg} - but VNC not connected`);
            return;
          }
          console.log(`[VncViewer] ${logMsg}`);
          action();
        };

        // === Cmd+Shift+<key> combinations ===
        if (e.metaKey && e.shiftKey && !e.altKey && !e.ctrlKey) {
          // Cmd+Shift+[ → Ctrl+PageUp (previous tab in Linux)
          if (code === "BracketLeft") {
            handleShortcut("Cmd+Shift+[ → Ctrl+PageUp (prev tab)", () => {
              sendKeyCombo(0xff55, "PageUp"); // XK_Page_Up, no shift needed
            });
            return;
          }
          // Cmd+Shift+] → Ctrl+PageDown (next tab in Linux)
          if (code === "BracketRight") {
            handleShortcut("Cmd+Shift+] → Ctrl+PageDown (next tab)", () => {
              sendKeyCombo(0xff56, "PageDown"); // XK_Page_Down, no shift needed
            });
            return;
          }
          // Cmd+Shift+Z → Ctrl+Shift+Z (redo)
          if (code === "KeyZ") {
            handleShortcut("Cmd+Shift+Z → Ctrl+Shift+Z", () => {
              sendKeyCombo(0x007a, "KeyZ", true);
            });
            return;
          }
          // Other Cmd+Shift combinations
          const cmdShiftMap: Record<string, [number, string]> = {
            KeyF: [0x0066, "KeyF"], // Find in files
            KeyS: [0x0073, "KeyS"], // Save as
            KeyP: [0x0070, "KeyP"], // Command palette
            KeyG: [0x0067, "KeyG"], // Find previous
          };
          if (cmdShiftMap[code]) {
            const [keysym, keyCode] = cmdShiftMap[code];
            handleShortcut(`Cmd+Shift+${code} → Ctrl+Shift+${code}`, () => {
              sendKeyCombo(keysym, keyCode, true);
            });
            return;
          }
        }

        // === Cmd+<key> (no shift) ===
        if (e.metaKey && !e.shiftKey && !e.altKey && !e.ctrlKey) {
          // Arrow keys: Cmd+Arrow → Home/End
          if (code === "ArrowLeft") {
            handleShortcut("Cmd+Left → Home", () => sendKeyCombo(0xff50, "Home"));
            return;
          }
          if (code === "ArrowRight") {
            handleShortcut("Cmd+Right → End", () => sendKeyCombo(0xff57, "End"));
            return;
          }
          if (code === "ArrowUp") {
            handleShortcut("Cmd+Up → Ctrl+Home", () => sendKeyCombo(0xff50, "Home"));
            return;
          }
          if (code === "ArrowDown") {
            handleShortcut("Cmd+Down → Ctrl+End", () => sendKeyCombo(0xff57, "End"));
            return;
          }

          // Cmd+Backspace → delete to beginning of line
          // Use Shift+Home (select to start) + Backspace (delete) instead of Ctrl+U
          // because Ctrl+U opens View Source in browsers
          if (code === "Backspace") {
            handleShortcut("Cmd+Backspace → Shift+Home, Backspace", () => {
              const rfb = rfbRef.current;
              if (!rfb) return;

              const XK_Shift_L = 0xffe1;
              const XK_Home = 0xff50;
              const XK_BackSpace = 0xff08;
              const XK_Meta_L = 0xffe7;
              const XK_Meta_R = 0xffe8;
              const XK_Super_L = 0xffeb;
              const XK_Super_R = 0xffec;

              // Release Meta/Super keys first
              rfb.sendKey(XK_Meta_L, "MetaLeft", false);
              rfb.sendKey(XK_Meta_R, "MetaRight", false);
              rfb.sendKey(XK_Super_L, "OSLeft", false);
              rfb.sendKey(XK_Super_R, "OSRight", false);

              // Shift+Home to select from cursor to beginning of line
              rfb.sendKey(XK_Shift_L, "ShiftLeft", true);
              rfb.sendKey(XK_Home, "Home", true);
              rfb.sendKey(XK_Home, "Home", false);
              rfb.sendKey(XK_Shift_L, "ShiftLeft", false);

              // Backspace to delete the selection
              rfb.sendKey(XK_BackSpace, "Backspace", true);
              rfb.sendKey(XK_BackSpace, "Backspace", false);
            });
            return;
          }

          // Cmd+V → Paste (special handling for clipboard)
          if (code === "KeyV") {
            e.preventDefault();
            e.stopPropagation();
            try {
              const text = await navigator.clipboard.readText();
              if (text && rfb) {
                console.log("[VncViewer] Cmd+V → paste");
                clipboardPaste(text);
              }
            } catch (err) {
              console.error("[VncViewer] Clipboard read failed:", err);
            }
            return;
          }

          // Standard Cmd+<key> → Ctrl+<key> mappings
          const cmdMap: Record<string, [number, string]> = {
            KeyA: [0x0061, "KeyA"], KeyB: [0x0062, "KeyB"], KeyC: [0x0063, "KeyC"],
            KeyD: [0x0064, "KeyD"], KeyF: [0x0066, "KeyF"], KeyG: [0x0067, "KeyG"],
            KeyH: [0x0068, "KeyH"], KeyI: [0x0069, "KeyI"], KeyK: [0x006b, "KeyK"],
            KeyL: [0x006c, "KeyL"], KeyN: [0x006e, "KeyN"], KeyO: [0x006f, "KeyO"],
            KeyP: [0x0070, "KeyP"], KeyR: [0x0072, "KeyR"], KeyS: [0x0073, "KeyS"],
            KeyT: [0x0074, "KeyT"], KeyU: [0x0075, "KeyU"], KeyW: [0x0077, "KeyW"],
            KeyX: [0x0078, "KeyX"], KeyY: [0x0079, "KeyY"], KeyZ: [0x007a, "KeyZ"],
            Slash: [0x002f, "Slash"],
            BracketLeft: [0x005b, "BracketLeft"],
            BracketRight: [0x005d, "BracketRight"],
            Minus: [0x002d, "Minus"],         // Zoom out (Ctrl+-)
            Equal: [0x003d, "Equal"],         // Zoom in (Ctrl+=)
            Digit0: [0x0030, "Digit0"],       // Reset zoom / Tab 10 (Ctrl+0)
            Digit1: [0x0031, "Digit1"],       // Tab 1 (Ctrl+1)
            Digit2: [0x0032, "Digit2"],       // Tab 2 (Ctrl+2)
            Digit3: [0x0033, "Digit3"],       // Tab 3 (Ctrl+3)
            Digit4: [0x0034, "Digit4"],       // Tab 4 (Ctrl+4)
            Digit5: [0x0035, "Digit5"],       // Tab 5 (Ctrl+5)
            Digit6: [0x0036, "Digit6"],       // Tab 6 (Ctrl+6)
            Digit7: [0x0037, "Digit7"],       // Tab 7 (Ctrl+7)
            Digit8: [0x0038, "Digit8"],       // Tab 8 (Ctrl+8)
            Digit9: [0x0039, "Digit9"],       // Tab 9 / Last tab (Ctrl+9)
          };
          if (cmdMap[code]) {
            const [keysym, keyCode] = cmdMap[code];
            handleShortcut(`Cmd+${code} → Ctrl+${code}`, () => sendKeyCombo(keysym, keyCode));
            return;
          }
        }

        // === Option+<key> (word navigation) ===
        if (e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
          if (code === "ArrowLeft") {
            handleShortcut("Option+Left → Ctrl+Left", () => sendCtrlKey(0xff51, "ArrowLeft", true));
            return;
          }
          if (code === "ArrowRight") {
            handleShortcut("Option+Right → Ctrl+Right", () => sendCtrlKey(0xff53, "ArrowRight", true));
            return;
          }
          if (code === "Backspace") {
            // Ctrl+Backspace = delete word backwards (works in terminals, VS Code, browsers)
            // Note: Ctrl+W is the readline binding but it also closes tabs in GUIs
            handleShortcut("Option+Backspace → Ctrl+Backspace", () => sendCtrlKey(0xff08, "Backspace", true));
            return;
          }
          if (code === "Delete") {
            // Option+Delete (Fn+Option+Backspace) → Ctrl+Delete = delete word forwards
            handleShortcut("Option+Delete → Ctrl+Delete", () => sendCtrlKey(0xffff, "Delete", true));
            return;
          }
        }

        // === Ctrl+<key> (GNU readline) ===
        if (e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
          const readlineMap: Record<string, [number, string]> = {
            KeyA: [0x0061, "KeyA"], // Beginning of line
            KeyE: [0x0065, "KeyE"], // End of line
            KeyK: [0x006b, "KeyK"], // Kill to end
            KeyU: [0x0075, "KeyU"], // Kill to beginning
            KeyW: [0x0077, "KeyW"], // Delete word
            KeyY: [0x0079, "KeyY"], // Yank
            KeyL: [0x006c, "KeyL"], // Clear screen
            KeyC: [0x0063, "KeyC"], // Interrupt
            KeyD: [0x0064, "KeyD"], // EOF
          };
          if (readlineMap[code]) {
            const [keysym, keyCode] = readlineMap[code];
            handleShortcut(`Ctrl+${code} → Ctrl+${code}`, () => sendCtrlKey(keysym, keyCode, false));
            return;
          }
        }
      };

      // Listen at document level with capture to intercept before browser default handlers
      document.addEventListener("keydown", handleKeyDown, { capture: true });
      return () => {
        document.removeEventListener("keydown", handleKeyDown, { capture: true });
      };
    }, [clipboardPaste, sendKeyCombo, sendCtrlKey, isVncFocused]);

    // Fallback: Document-level paste event listener
    // Handles cases where keydown might not fire (e.g., Electron menu triggers paste)
    useEffect(() => {
      const container = containerRef.current;
      if (!container) return;

      const handleDocumentPaste = (e: ClipboardEvent) => {
        // Only handle if VNC container has focus
        if (!container.contains(document.activeElement)) return;
        if (!rfbRef.current) return;

        const text =
          e.clipboardData?.getData("text/plain") ||
          e.clipboardData?.getData("text");
        if (text) {
          console.log("[VncViewer] Document paste event intercepted");
          e.preventDefault();
          e.stopPropagation();
          clipboardPaste(text);
        }
      };

      // Capture phase to intercept before other handlers
      document.addEventListener("paste", handleDocumentPaste, { capture: true });
      return () => document.removeEventListener("paste", handleDocumentPaste, { capture: true });
    }, [clipboardPaste]);

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


    // Handle container click for focus
    const handleContainerClick = useCallback(() => {
      if (focusOnClick && rfbRef.current) {
        focus();
      }
    }, [focusOnClick, focus]);

    // Compute what to render
    const showLoading = (status === "connecting" || status === "disconnected") && !isOffline;
    const showError = status === "error" || isOffline;

    // Default loading fallback
    const defaultLoadingFallback = useMemo(
      () => (
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="flex flex-col items-center gap-2">
            <div className="h-5 w-5 animate-spin rounded-full border-[1.5px] border-neutral-600 border-t-transparent" />
            <span className="text-xs text-neutral-500">
              {status === "connecting"
                ? reconnectAttempt > 0
                  ? `Reconnecting (${reconnectAttempt})...`
                  : "Connecting..."
                : ""}
            </span>
            {reconnectAttempt > 0 && errorMessage && (
              <span className="text-xs text-neutral-600 max-w-[240px] text-center">
                {errorMessage}
              </span>
            )}
          </div>
        </div>
      ),
      [status, reconnectAttempt, errorMessage]
    );

    // Default error fallback
    const defaultErrorFallback = useMemo(
      () => (
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="flex flex-col items-center gap-3 text-center px-4">
            {isOffline ? (
              // Network offline state
              <>
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-amber-500/10">
                  <svg
                    className="h-5 w-5 text-amber-400"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={2}
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M18.364 5.636a9 9 0 010 12.728m0 0l-2.829-2.829m2.829 2.829L21 21M15.536 8.464a5 5 0 010 7.072m0 0l-2.829-2.829m-4.243 2.829a4.978 4.978 0 01-1.414-2.83m-1.414 5.658a9 9 0 01-2.167-9.238m7.824 2.167a1 1 0 111.414 1.414m-1.414-1.414L3 3m8.293 8.293l1.414 1.414"
                    />
                  </svg>
                </div>
                <div className="flex flex-col gap-1">
                  <span className="text-sm font-medium text-neutral-200">
                    Network offline
                  </span>
                  <span className="text-xs text-neutral-400 max-w-[280px]">
                    Check your internet connection. Will reconnect automatically when online.
                  </span>
                </div>
              </>
            ) : (
              // Server/connection error state
              <>
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-red-500/10">
                  <svg
                    className="h-5 w-5 text-red-400"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={2}
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                    />
                  </svg>
                </div>
                <div className="flex flex-col gap-1">
                  <span className="text-sm font-medium text-neutral-200">
                    Connection failed
                  </span>
                  {errorMessage && (
                    <span className="text-xs text-neutral-400 max-w-[280px]">
                      {errorMessage}
                    </span>
                  )}
                </div>
                <button
                  type="button"
                  onClick={connect}
                  className="mt-1 rounded-md bg-neutral-700 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-600 transition-colors"
                >
                  Retry connection
                </button>
              </>
            )}
          </div>
        </div>
      ),
      [connect, errorMessage, isOffline]
    );

    // Prevent Electron's context menu so noVNC can handle right-clicks
    const handleContextMenu = useCallback((e: React.MouseEvent) => {
      e.preventDefault();
    }, []);

    return (
      <div
        className={clsx("relative overflow-hidden", className)}
        style={{ background, ...style }}
        onClick={handleContainerClick}
        onContextMenu={handleContextMenu}
        data-drag-disable-pointer
      >
        {/* VNC Canvas Container - noVNC creates canvas inside this */}
        <div
          ref={containerRef}
          className="absolute inset-0"
          style={{ background }}
          tabIndex={0}
          data-drag-disable-pointer
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
