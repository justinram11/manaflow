import { client } from "@cmux/compute-provider-client/client.gen";
import { env } from "./www-env";

/**
 * Configure the compute-provider HTTP client with base URL and bearer token.
 *
 * Must be called before using any compute-provider-client SDK functions.
 */
export function getComputeProviderClient() {
  const baseUrl = env.COMPUTE_PROVIDER_URL ?? "http://localhost:9780";
  const apiKey = env.COMPUTE_PROVIDER_API_KEY;

  if (!apiKey) {
    throw new Error("COMPUTE_PROVIDER_API_KEY is required when SANDBOX_PROVIDER=incus");
  }

  client.setConfig({
    baseUrl,
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });

  return client;
}
