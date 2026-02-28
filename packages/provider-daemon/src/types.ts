export interface JsonRpcRequest {
  jsonrpc: string;
  method: string;
  params?: Record<string, unknown>;
  id: string | number;
}

export interface JsonRpcResponse {
  jsonrpc: string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
  id: string | number;
}

export interface CapabilityHandler {
  /** Capability identifier, e.g. "compute:incus" */
  capability: string;

  /** JSON-RPC methods this capability handles */
  methods: string[];

  /** Handle a JSON-RPC request */
  handle(request: JsonRpcRequest): Promise<JsonRpcResponse>;

  /** Clean up resources on shutdown */
  shutdown?(): Promise<void>;
}

export interface DaemonConfig {
  serverUrl: string;
  token: string;
  maxConcurrentSlots?: number;
}
