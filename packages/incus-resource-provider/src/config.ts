/**
 * Configuration for the Incus-backed Android resource provider.
 */
export interface IncusResourceProviderConfig {
  /** Incus image alias for the Android emulator container. */
  androidImage: string;
  /** Port the in-container vm-android-mcp-server listens on. */
  vmMcpPort: number;
}

export function loadIncusResourceProviderConfig(): IncusResourceProviderConfig {
  return {
    androidImage: process.env.CMUX_ANDROID_INCUS_IMAGE ?? "cmux-sandbox-android",
    vmMcpPort: Number(process.env.CMUX_ANDROID_VM_MCP_PORT) || 4860,
  };
}
