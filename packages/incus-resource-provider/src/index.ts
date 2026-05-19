/**
 * @cmux/incus-resource-provider
 *
 * Host-side library for the Android emulator resource provider. Mirrors
 * @cmux/mac-resource-provider, but manages a fresh Incus container per
 * allocation (instead of a shared Tart VM):
 *
 *   - `incus launch cmux-sandbox-android` on attach
 *   - passes through /dev/kvm + /dev/net/tun
 *   - joins Tailscale, boots the emulator, starts vm-android-mcp-server
 *   - `incus delete --force` on release
 *
 * The provider-daemon `resource:android-emulator` capability handler drives
 * this library; the backend talks to the in-container MCP server directly
 * over HTTP+bearer.
 */
export {
  setupAllocation,
  cleanupAllocation,
  getAllocation,
  getAllAllocations,
  type AndroidAllocationInfo,
} from "./workspace-manager";
export {
  detectIncus,
  incusLaunch,
  incusDelete,
  incusExec,
  incusContainerInfo,
  waitForContainerIp,
} from "./incus";
export {
  loadIncusResourceProviderConfig,
  type IncusResourceProviderConfig,
} from "./config";
