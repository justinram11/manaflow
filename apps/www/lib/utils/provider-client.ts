/**
 * Generic function to send JSON-RPC to any provider via the server's internal API.
 */
const CMUX_SERVER_URL = process.env.CMUX_SERVER_INTERNAL_URL ?? "http://localhost:3001";

let requestCounter = 0;

export async function sendProviderRequest(
  providerId: string,
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const requestId = `provider-${++requestCounter}-${Date.now()}`;

  const res = await fetch(
    `${CMUX_SERVER_URL}/internal/provider/${providerId}/json-rpc`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        request: {
          jsonrpc: "2.0",
          method,
          params,
          id: requestId,
        },
      }),
    },
  );

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Provider request failed (${res.status}): ${errorText}`);
  }

  const response = await res.json() as {
    result?: unknown;
    error?: { code: number; message: string; data?: unknown };
  };

  if (response.error) {
    throw new Error(`Provider JSON-RPC error: ${response.error.message}`);
  }

  return response.result;
}
