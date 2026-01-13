#!/usr/bin/env bun
/**
 * Test script for the Convex Anthropic proxy endpoint.
 *
 * Usage:
 *   bun scripts/test-anthropic-proxy.ts [--stream] [--model MODEL]
 *
 * Environment variables:
 *   NEXT_PUBLIC_CONVEX_URL - Convex deployment URL (required)
 *
 * Examples:
 *   bun scripts/test-anthropic-proxy.ts
 *   bun scripts/test-anthropic-proxy.ts --stream
 *   bun scripts/test-anthropic-proxy.ts --model claude-sonnet-4-5-20250514
 */

const args = process.argv.slice(2);
const useStream = args.includes("--stream");
const modelIndex = args.indexOf("--model");
const model =
  modelIndex !== -1 && args[modelIndex + 1]
    ? args[modelIndex + 1]
    : "claude-opus-4-5";

const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
if (!convexUrl) {
  console.error("Error: NEXT_PUBLIC_CONVEX_URL environment variable is required");
  console.error("Set it to your Convex deployment URL (e.g., https://your-deployment.convex.cloud)");
  process.exit(1);
}

// Convert .convex.cloud to .convex.site for HTTP endpoints
const siteUrl = convexUrl.replace(".convex.cloud", ".convex.site");
const endpoint = `${siteUrl}/api/anthropic/v1/messages`;

console.log("=== Anthropic Proxy Test ===");
console.log(`Endpoint: ${endpoint}`);
console.log(`Model: ${model}`);
console.log(`Stream: ${useStream}`);
console.log("");

const requestBody = {
  model,
  max_tokens: 256,
  stream: useStream,
  messages: [
    {
      role: "user",
      content: "Say 'Hello from Vertex AI!' and nothing else.",
    },
  ],
};

async function testNonStreaming(): Promise<void> {
  console.log("Sending non-streaming request...");
  const startTime = Date.now();

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": "sk_placeholder_cmux_anthropic_api_key",
    },
    body: JSON.stringify(requestBody),
  });

  const latency = Date.now() - startTime;
  console.log(`Response status: ${response.status}`);
  console.log(`Latency: ${latency}ms`);

  if (!response.ok) {
    const errorText = await response.text();
    console.error("Error response:", errorText);
    process.exit(1);
  }

  const data = await response.json();
  console.log("\nResponse:");
  console.log(JSON.stringify(data, null, 2));

  if (data.content?.[0]?.text) {
    console.log("\n--- Assistant Message ---");
    console.log(data.content[0].text);
  }

  if (data.usage) {
    console.log("\n--- Token Usage ---");
    console.log(`Input tokens: ${data.usage.input_tokens}`);
    console.log(`Output tokens: ${data.usage.output_tokens}`);
    if (data.usage.cache_read_input_tokens) {
      console.log(`Cache read: ${data.usage.cache_read_input_tokens}`);
    }
  }
}

async function testStreaming(): Promise<void> {
  console.log("Sending streaming request...");
  const startTime = Date.now();

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": "sk_placeholder_cmux_anthropic_api_key",
    },
    body: JSON.stringify(requestBody),
  });

  const ttfb = Date.now() - startTime;
  console.log(`Response status: ${response.status}`);
  console.log(`Time to first byte: ${ttfb}ms`);

  if (!response.ok) {
    const errorText = await response.text();
    console.error("Error response:", errorText);
    process.exit(1);
  }

  if (!response.body) {
    console.error("No response body for streaming");
    process.exit(1);
  }

  console.log("\n--- Streaming Response ---");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let fullText = "";
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    // Process complete SSE lines
    const lines = buffer.split("\n");
    buffer = lines.pop() || ""; // Keep incomplete line in buffer

    for (const line of lines) {
      if (line.startsWith("data: ")) {
        const data = line.slice(6);
        if (data === "[DONE]") {
          continue;
        }

        try {
          const parsed = JSON.parse(data);

          // Handle content_block_delta events
          if (parsed.type === "content_block_delta") {
            const text = parsed.delta?.text || "";
            process.stdout.write(text);
            fullText += text;
          }

          // Handle message_start for metadata
          if (parsed.type === "message_start" && parsed.message?.usage) {
            // Initial usage info
          }

          // Handle message_delta for final usage
          if (parsed.type === "message_delta" && parsed.usage) {
            console.log("\n\n--- Token Usage ---");
            console.log(`Output tokens: ${parsed.usage.output_tokens}`);
          }
        } catch {
          // Skip non-JSON lines
        }
      }
    }
  }

  const totalTime = Date.now() - startTime;
  console.log(`\n\nTotal time: ${totalTime}ms`);
  console.log(`Full response: "${fullText}"`);
}

async function runTest(): Promise<void> {
  try {
    if (useStream) {
      await testStreaming();
    } else {
      await testNonStreaming();
    }
    console.log("\n=== Test Complete ===");
  } catch (error) {
    console.error("Test failed:", error);
    process.exit(1);
  }
}

runTest();
