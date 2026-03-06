Fake VNC status as of 2026-03-06

What works
- Browser-side simulator controls work through the screenshot fallback path.
- The active iOS allocation was reduced to a single booted simulator.
- The Mac capture helper now finds the Simulator window by `CGWindowListCopyWindowInfo`.
- The Mac capture helper can capture the Simulator window with `SCScreenshotManager.captureImage(in:)`.
- Direct raw RFB probing against the Mac helper succeeds and returns `ServerInit` with the expected framebuffer size.

Current architecture
- Mac provider launches `SimulatorCapture.swift` per allocation.
- Provider daemon bridges workspace raw VNC input to the local capture port with `DirectVncBridge`.
- Workspace runs `ios-vnc-proxy.mjs` to expose a browser WebSocket endpoint on `39387`.
- Browser connects to the workspace `websockify` endpoint with noVNC.

Known issues
- The browser still falls back to screenshots because the workspace VNC relay is not forwarding bytes to the browser correctly.
- The container-local relay test currently fails:
  - writing bytes to `127.0.0.1:39386` does not produce bytes on a WebSocket client connected to `127.0.0.1:39387/websockify`
- The Mac provider currently has stale historical capture processes on old ports from earlier debugging runs.
- The active allocation was reconnected onto port `51060` for debugging, but the browser path still does not receive a usable framebuffer.

Files touched on this branch
- `packages/mac-resource-provider/capture/SimulatorCapture.swift`
- `packages/shared/src/providers/mcp/ios-vnc-proxy.mjs`

Recommended resume point
1. Fix or replace the workspace `ios-vnc-proxy.mjs` relay.
2. If staying on the fake-VNC path, clean up stale Mac capture processes and validate one fresh allocation end-to-end.
3. Alternative pivot: replace the fake-VNC display path with TrollVNC or another real simulator-side VNC server.
