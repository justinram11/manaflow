"use node";

import { internalAction } from "./_generated/server";
import { v } from "convex/values";
import { env } from "../_shared/convex-env";
import {
  DEFAULT_MODAL_TEMPLATE_ID,
  getModalTemplateByPresetId,
} from "@cmux/shared/modal-templates";
import { ModalClient, type ModalInstance } from "@cmux/modal-client";

/**
 * Get Modal client with credentials from env
 */
function getModalClient(): ModalClient {
  const tokenId = env.MODAL_TOKEN_ID;
  const tokenSecret = env.MODAL_TOKEN_SECRET;
  if (!tokenId || !tokenSecret) {
    throw new Error("MODAL_TOKEN_ID and MODAL_TOKEN_SECRET not configured");
  }
  return new ModalClient({ tokenId, tokenSecret });
}

/**
 * Generate a 64-char hex auth token (same format as E2B worker daemon).
 */
function generateAuthToken(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return Array.from(array, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Extract networking URLs from Modal instance.
 */
function extractNetworkingUrls(instance: ModalInstance) {
  const httpServices = instance.networking.httpServices;
  const jupyterService = httpServices.find(
    (s) => s.port === 8888 || s.name === "jupyter",
  );
  const vscodeService = httpServices.find(
    (s) => s.port === 39378 || s.name === "vscode",
  );

  return {
    jupyterUrl: jupyterService?.url,
    vscodeUrl: vscodeService?.url,
  };
}

/**
 * Setup script that installs Jupyter Lab + code-server and starts them with token auth.
 * Writes token to /home/user/.worker-auth-token for compatibility with E2B auth flow.
 */
function buildSetupScript(authToken: string): string {
  return `#!/bin/bash
set -e

# Create workspace directory
mkdir -p /home/user/workspace

# Write auth token (same path as E2B for compatibility)
echo -n '${authToken}' > /home/user/.worker-auth-token
chmod 600 /home/user/.worker-auth-token

# Install system dependencies if needed
if ! command -v curl &>/dev/null; then
  apt-get update -qq > /dev/null 2>&1
  apt-get install -y -qq curl procps > /dev/null 2>&1
fi

# Install JupyterLab
pip install -q jupyterlab 2>/dev/null

# Install code-server (VS Code in browser)
curl -fsSL https://code-server.dev/install.sh | sh -s -- --method standalone > /dev/null 2>&1

# Start Jupyter Lab on port 8888 with token auth
nohup jupyter lab \\
  --ip=0.0.0.0 \\
  --port=8888 \\
  --ServerApp.token='${authToken}' \\
  --ServerApp.allow_root=True \\
  --ServerApp.root_dir=/home/user/workspace \\
  --no-browser \\
  > /tmp/jupyter.log 2>&1 &

# Start code-server (VS Code) on port 39378
# Uses password auth with the same token
export PASSWORD='${authToken}'
nohup code-server \\
  --bind-addr 0.0.0.0:39378 \\
  --auth password \\
  --disable-telemetry \\
  --disable-update-check \\
  /home/user/workspace \\
  > /tmp/code-server.log 2>&1 &

# Wait for services to start
sleep 2
echo "SETUP_COMPLETE"
`;
}

/**
 * Start a new Modal sandbox instance with Jupyter + code-server + token auth.
 */
export const startInstance = internalAction({
  args: {
    templateId: v.optional(v.string()),
    gpu: v.optional(v.string()),
    cpu: v.optional(v.number()),
    memoryMiB: v.optional(v.number()),
    ttlSeconds: v.optional(v.number()),
    metadata: v.optional(v.record(v.string(), v.string())),
    envs: v.optional(v.record(v.string(), v.string())),
    image: v.optional(v.string()),
  },
  handler: async (_ctx, args) => {
    const client = getModalClient();

    // Resolve template preset to get GPU/image config
    const presetId = args.templateId ?? DEFAULT_MODAL_TEMPLATE_ID;
    const preset = getModalTemplateByPresetId(presetId);
    const gpu = args.gpu ?? preset?.gpu;
    const image = args.image ?? preset?.image ?? "python:3.11-slim";

    try {
      const instance = await client.instances.start({
        gpu,
        cpu: args.cpu,
        memoryMiB: args.memoryMiB,
        timeoutSeconds: args.ttlSeconds ?? 60 * 60,
        metadata: args.metadata,
        envs: args.envs,
        image,
        encryptedPorts: [8888, 39378],
      });

      // Generate auth token (same format as E2B: 64 hex chars)
      const authToken = generateAuthToken();

      // Run setup script to install Jupyter + code-server + write token
      console.log("[modal_actions] Running setup script...");
      const setupResult = await instance.exec(buildSetupScript(authToken));
      if (setupResult.exit_code !== 0) {
        console.error(
          "[modal_actions] Setup script failed:",
          setupResult.stderr,
        );
      }

      // Refresh tunnel URLs after services are started
      await instance.refreshTunnels();
      const { jupyterUrl, vscodeUrl } = extractNetworkingUrls(instance);

      return {
        instanceId: instance.id,
        status: "running",
        gpu: gpu ?? null,
        authToken,
        jupyterUrl: jupyterUrl
          ? `${jupyterUrl}?token=${authToken}`
          : undefined,
        vscodeUrl,
        vncUrl: undefined,
      };
    } finally {
      client.close();
    }
  },
});

/**
 * Get Modal instance status.
 */
export const getInstance = internalAction({
  args: {
    instanceId: v.string(),
  },
  handler: async (_ctx, args) => {
    const client = getModalClient();
    try {
      const instance = await client.instances.get({
        instanceId: args.instanceId,
      });
      const isRunning = await instance.isRunning();

      // Refresh tunnels for current URLs
      await instance.refreshTunnels();
      const { jupyterUrl, vscodeUrl } = extractNetworkingUrls(instance);

      return {
        instanceId: args.instanceId,
        status: isRunning ? "running" : "stopped",
        jupyterUrl,
        vscodeUrl,
        workerUrl: null,
        vncUrl: null,
      };
    } catch {
      return {
        instanceId: args.instanceId,
        status: "stopped",
        jupyterUrl: null,
        vscodeUrl: null,
        workerUrl: null,
        vncUrl: null,
      };
    } finally {
      client.close();
    }
  },
});

/**
 * Execute a command in a Modal sandbox.
 * Returns result even for non-zero exit codes.
 */
export const execCommand = internalAction({
  args: {
    instanceId: v.string(),
    command: v.string(),
  },
  handler: async (_ctx, args) => {
    const client = getModalClient();
    try {
      const instance = await client.instances.get({
        instanceId: args.instanceId,
      });
      const result = await instance.exec(args.command);

      return {
        stdout: result.stdout,
        stderr: result.stderr,
        exit_code: result.exit_code,
      };
    } catch (err) {
      console.error("[modal_actions.execCommand] Error:", err);
      return {
        stdout: "",
        stderr: err instanceof Error ? err.message : String(err),
        exit_code: 1,
      };
    } finally {
      client.close();
    }
  },
});

/**
 * Stop (terminate) a Modal sandbox.
 */
export const stopInstance = internalAction({
  args: {
    instanceId: v.string(),
  },
  handler: async (_ctx, args) => {
    const client = getModalClient();
    try {
      await client.instances.kill(args.instanceId);
      return { stopped: true };
    } finally {
      client.close();
    }
  },
});

/**
 * List all running Modal sandboxes.
 */
export const listInstances = internalAction({
  args: {},
  handler: async () => {
    const client = getModalClient();
    try {
      const sandboxes = await client.instances.list();
      return sandboxes.map((s) => ({
        sandboxId: s.sandboxId,
        startedAt: s.startedAt.toISOString(),
      }));
    } finally {
      client.close();
    }
  },
});
