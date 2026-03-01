/**
 * AWS EC2 compute provider for cmux sandboxes.
 *
 * Each sandbox is a single EC2 instance (ARM/Graviton) launched from a golden
 * AMI, with Tailscale for secure dev-to-workspace networking.
 *
 * Lifecycle: Launch → Running → Stopped (TTL) → Terminated (archive timeout)
 *
 * The central cmux server calls AWS APIs directly — no per-region daemon.
 */

import { env } from "@/lib/utils/www-env";
import { type AwsConfig, buildAwsConfigFromEnv, WORKSPACE_PORTS } from "@cmux/shared/aws-config";
import type { SandboxExecResult, SandboxInstance } from "./sandbox-instance";
import {
  createEc2Client,
  launchInstance,
  waitForInstanceState,
  stopInstance,
  startInstance,
  terminateInstance,
  createAmi,
  listAmis,
  deregisterAmi,
} from "./aws-ec2";
import {
  createTailscaleClient,
  generateTailscaleUserData,
  type TailscaleClient,
} from "./aws-tailscale";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

let _awsConfig: AwsConfig | null = null;

function getAwsConfig(): AwsConfig {
  if (!_awsConfig) {
    _awsConfig = buildAwsConfigFromEnv({
      defaultInstanceType: env.AWS_EC2_INSTANCE_TYPE,
      defaultRegion: env.AWS_EC2_REGION,
      amiIds: env.AWS_EC2_AMI_IDS,
      subnetIds: env.AWS_EC2_SUBNET_IDS,
      securityGroupIds: env.AWS_EC2_SECURITY_GROUP_IDS,
    });
  }
  return _awsConfig;
}

let _tailscaleClient: TailscaleClient | null = null;

function getTailscaleClient(): TailscaleClient {
  if (!_tailscaleClient) {
    const apiKey = env.TAILSCALE_API_KEY;
    const tailnet = env.TAILSCALE_TAILNET;
    if (!apiKey || !tailnet) {
      throw new Error(
        "TAILSCALE_API_KEY and TAILSCALE_TAILNET are required for the AWS provider",
      );
    }
    _tailscaleClient = createTailscaleClient({ apiKey, tailnet });
  }
  return _tailscaleClient;
}

function getEc2Credentials(): { accessKeyId: string; secretAccessKey: string } | undefined {
  if (env.AWS_EC2_ACCESS_KEY_ID && env.AWS_EC2_SECRET_ACCESS_KEY) {
    return {
      accessKeyId: env.AWS_EC2_ACCESS_KEY_ID,
      secretAccessKey: env.AWS_EC2_SECRET_ACCESS_KEY,
    };
  }
  // Fall back to default AWS credential chain (IAM role, env vars, etc.)
  return undefined;
}

// ---------------------------------------------------------------------------
// Exec via HTTP exec daemon (port 39375)
// ---------------------------------------------------------------------------

/**
 * Execute a command on a workspace instance via the HTTP exec daemon.
 * The exec daemon runs inside the sandbox on port 39375 and accepts
 * JSON requests, returning JSONL with stdout/stderr/exit events.
 */
async function execViaHttpDaemon(
  tailscaleIp: string,
  command: string,
  timeoutMs = 120_000,
): Promise<SandboxExecResult> {
  const url = `http://${tailscaleIp}:${WORKSPACE_PORTS.exec}/exec`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ command, timeout_ms: timeoutMs }),
    signal: AbortSignal.timeout(timeoutMs + 5_000),
  });

  if (!res.ok) {
    const text = await res.text();
    return {
      exit_code: 1,
      stdout: "",
      stderr: `exec daemon HTTP ${res.status}: ${text.slice(0, 500)}`,
    };
  }

  const body = await res.text();
  const lines = body.trim().split("\n").filter(Boolean);

  let stdout = "";
  let stderr = "";
  let exitCode = 1;

  for (const line of lines) {
    try {
      const event = JSON.parse(line) as {
        type: string;
        data?: string;
        code?: number;
        message?: string;
      };
      switch (event.type) {
        case "stdout":
          stdout += (event.data ?? "") + "\n";
          break;
        case "stderr":
          stderr += (event.data ?? "") + "\n";
          break;
        case "exit":
          exitCode = event.code ?? 1;
          break;
        case "error":
          stderr += (event.message ?? "") + "\n";
          break;
      }
    } catch {
      // Skip malformed JSONL lines
    }
  }

  return { exit_code: exitCode, stdout: stdout.trimEnd(), stderr: stderr.trimEnd() };
}

// ---------------------------------------------------------------------------
// AwsSandboxInstance
// ---------------------------------------------------------------------------

/**
 * SandboxInstance backed by an AWS EC2 instance with Tailscale networking.
 */
export class AwsSandboxInstance implements SandboxInstance {
  readonly id: string;
  readonly region: string;
  readonly tailscaleIp: string;
  readonly tailscaleHostname: string;
  private _tailscaleDeviceId: string | undefined;

  constructor(opts: {
    instanceId: string;
    region: string;
    tailscaleIp: string;
    tailscaleHostname: string;
    tailscaleDeviceId?: string;
  }) {
    this.id = opts.instanceId;
    this.region = opts.region;
    this.tailscaleIp = opts.tailscaleIp;
    this.tailscaleHostname = opts.tailscaleHostname;
    this._tailscaleDeviceId = opts.tailscaleDeviceId;
  }

  async exec(command: string): Promise<SandboxExecResult> {
    try {
      return await execViaHttpDaemon(this.tailscaleIp, command);
    } catch (error) {
      console.error("[AwsSandboxInstance] exec failed:", error);
      return { exit_code: 1, stdout: "", stderr: String(error) };
    }
  }

  async stop(): Promise<void> {
    const client = createEc2Client(this.region, getEc2Credentials());
    await stopInstance(client, this.id);
  }

  async terminate(): Promise<void> {
    const client = createEc2Client(this.region, getEc2Credentials());
    await terminateInstance(client, this.id);

    // Clean up Tailscale device if we have the ID
    if (this._tailscaleDeviceId) {
      try {
        const ts = getTailscaleClient();
        await ts.deleteDevice(this._tailscaleDeviceId);
      } catch (error) {
        // Ephemeral keys auto-deregister, so this is best-effort
        console.error("[AwsSandboxInstance] Tailscale device cleanup failed:", error);
      }
    }
  }

  async resume(): Promise<AwsSandboxInstance> {
    const client = createEc2Client(this.region, getEc2Credentials());
    await startInstance(client, this.id);
    await waitForInstanceState(client, this.id, "running", 60_000);

    // Tailscale IP may change after stop/start — re-discover
    const ts = getTailscaleClient();
    const device = await ts.waitForDevice(this.tailscaleHostname, 90_000);

    return new AwsSandboxInstance({
      instanceId: this.id,
      region: this.region,
      tailscaleIp: device.addresses[0],
      tailscaleHostname: this.tailscaleHostname,
      tailscaleDeviceId: device.id,
    });
  }
}

// ---------------------------------------------------------------------------
// AWS registry — tracks active AWS instances in-memory
// ---------------------------------------------------------------------------

interface AwsRegistryEntry {
  instance: AwsSandboxInstance;
  createdAt: number;
  ttlMs: number;
  stoppedAt?: number;
}

const awsRegistry = new Map<string, AwsRegistryEntry>();

export function getAwsRegistryEntry(instanceId: string): AwsRegistryEntry | undefined {
  return awsRegistry.get(instanceId);
}

export function getAllAwsRegistryEntries(): AwsRegistryEntry[] {
  return [...awsRegistry.values()];
}

// ---------------------------------------------------------------------------
// Start an AWS sandbox
// ---------------------------------------------------------------------------

export interface AwsSandboxResult {
  instance: AwsSandboxInstance;
  instanceId: string;
  hostPorts: Record<number, string>;
  vscodeUrl: string;
  workerUrl: string;
  urls: {
    vscode: string;
    worker: string;
    proxy: string;
    vnc: string;
    pty: string;
  };
}

/**
 * Launch a new AWS EC2 sandbox instance.
 *
 * Flow:
 *  1. Generate ephemeral Tailscale auth key
 *  2. Launch EC2 instance with user-data that joins the tailnet
 *  3. Wait for EC2 instance to reach "running" state
 *  4. Wait for Tailscale device to appear and get its IP
 *  5. Optionally share the node to external tailnets
 *  6. Return sandbox result with Tailscale-based URLs
 */
export async function startAwsSandbox(options: {
  region?: string;
  instanceType?: string;
  amiId?: string;
  ttlSeconds?: number;
  metadata?: Record<string, string>;
}): Promise<AwsSandboxResult> {
  const config = getAwsConfig();
  const region = options.region ?? config.defaultRegion;
  const instanceType = options.instanceType ?? config.defaultInstanceType;

  const regionConfig = config.regions[region];
  if (!regionConfig) {
    throw new Error(
      `AWS region "${region}" is not configured. Available regions: ${Object.keys(config.regions).join(", ") || "none"}`,
    );
  }

  const amiId = options.amiId ?? regionConfig.amiId;
  const credentials = getEc2Credentials();
  const ec2 = createEc2Client(region, credentials);
  const ts = getTailscaleClient();

  const sandboxId = `cmux-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const tailscaleHostname = sandboxId;

  console.log(
    `[aws-provider] Launching ${instanceType} in ${region} (AMI: ${amiId}, hostname: ${tailscaleHostname})`,
  );

  // Step 1: Generate ephemeral Tailscale auth key
  const authKey = await ts.createAuthKey({
    description: `cmux workspace ${sandboxId}`,
    tags: ["tag:workspace"],
    expirySeconds: 600, // 10 min window to boot and join
  });

  // Step 2: Build user-data and launch
  const userData = generateTailscaleUserData({
    authKey: authKey.key,
    hostname: tailscaleHostname,
  });

  const metadata: Record<string, string> = {
    app: "cmux",
    "sandbox-id": sandboxId,
    "created-at": String(Date.now()),
    "ttl-seconds": String(options.ttlSeconds ?? 3600),
    ...(options.metadata ?? {}),
  };

  const { instanceId } = await launchInstance(ec2, {
    amiId,
    instanceType,
    securityGroupId: regionConfig.securityGroupId,
    subnetId: regionConfig.subnetId,
    userData,
    metadata,
  });

  console.log(`[aws-provider] EC2 instance ${instanceId} launched, waiting for running state...`);

  try {
    // Step 3: Wait for EC2 to be running
    await waitForInstanceState(ec2, instanceId, "running", 120_000);
    console.log(`[aws-provider] EC2 instance ${instanceId} is running, waiting for Tailscale...`);

    // Step 4: Wait for Tailscale device to appear
    const device = await ts.waitForDevice(tailscaleHostname, 120_000);
    const tailscaleIp = device.addresses[0];
    console.log(`[aws-provider] Tailscale device online: ${tailscaleHostname} → ${tailscaleIp}`);

    // Step 5: Share to external tailnets if configured
    const shareTailnets = env.TAILSCALE_SHARE_TO_TAILNETS;
    if (shareTailnets) {
      try {
        const tailnets: string[] = JSON.parse(shareTailnets);
        for (const targetTailnet of tailnets) {
          await ts.shareDevice(device.id, targetTailnet);
          console.log(`[aws-provider] Shared ${tailscaleHostname} to tailnet ${targetTailnet}`);
        }
      } catch (error) {
        console.error("[aws-provider] Failed to share device to tailnets:", error);
      }
    }

    // Step 6: Build result
    const instance = new AwsSandboxInstance({
      instanceId,
      region,
      tailscaleIp,
      tailscaleHostname,
      tailscaleDeviceId: device.id,
    });

    const ttlMs = (options.ttlSeconds ?? 3600) * 1000;
    awsRegistry.set(instanceId, {
      instance,
      createdAt: Date.now(),
      ttlMs,
    });

    // Ports are direct — no mapping needed since each instance is a full VM
    const makeUrl = (port: number) => `http://${tailscaleIp}:${port}`;

    const hostPorts: Record<number, string> = {};
    for (const port of Object.values(WORKSPACE_PORTS)) {
      hostPorts[port as number] = String(port);
    }

    return {
      instance,
      instanceId,
      hostPorts,
      vscodeUrl: makeUrl(WORKSPACE_PORTS.vscode),
      workerUrl: makeUrl(WORKSPACE_PORTS.worker),
      urls: {
        vscode: makeUrl(WORKSPACE_PORTS.vscode),
        worker: makeUrl(WORKSPACE_PORTS.worker),
        proxy: makeUrl(WORKSPACE_PORTS.proxy),
        vnc: makeUrl(WORKSPACE_PORTS.vnc),
        pty: makeUrl(WORKSPACE_PORTS.pty),
      },
    };
  } catch (error) {
    // Cleanup on failure
    console.error(`[aws-provider] Launch failed for ${instanceId}, terminating:`, error);
    try {
      await terminateInstance(ec2, instanceId);
    } catch (cleanupErr) {
      console.error(`[aws-provider] Cleanup termination failed:`, cleanupErr);
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Lifecycle operations
// ---------------------------------------------------------------------------

/** Stop an AWS sandbox (preserves EBS, $0 compute). */
export async function stopAwsSandbox(instanceId: string): Promise<void> {
  const entry = awsRegistry.get(instanceId);
  if (!entry) {
    throw new Error(`AWS instance ${instanceId} not found in registry`);
  }
  await entry.instance.stop();
  entry.stoppedAt = Date.now();
}

/** Resume a stopped AWS sandbox. Returns updated instance with new Tailscale IP. */
export async function resumeAwsSandbox(instanceId: string): Promise<AwsSandboxResult> {
  const entry = awsRegistry.get(instanceId);
  if (!entry) {
    throw new Error(`AWS instance ${instanceId} not found in registry`);
  }

  const resumedInstance = await entry.instance.resume();

  // Update registry with new instance (may have new Tailscale IP)
  entry.instance = resumedInstance;
  entry.stoppedAt = undefined;
  entry.createdAt = Date.now(); // Reset TTL on resume

  const makeUrl = (port: number) => `http://${resumedInstance.tailscaleIp}:${port}`;

  const hostPorts: Record<number, string> = {};
  for (const [, port] of Object.entries(WORKSPACE_PORTS)) {
    hostPorts[port] = String(port);
  }

  return {
    instance: resumedInstance,
    instanceId,
    hostPorts,
    vscodeUrl: makeUrl(WORKSPACE_PORTS.vscode),
    workerUrl: makeUrl(WORKSPACE_PORTS.worker),
    urls: {
      vscode: makeUrl(WORKSPACE_PORTS.vscode),
      worker: makeUrl(WORKSPACE_PORTS.worker),
      proxy: makeUrl(WORKSPACE_PORTS.proxy),
      vnc: makeUrl(WORKSPACE_PORTS.vnc),
      pty: makeUrl(WORKSPACE_PORTS.pty),
    },
  };
}

/** Terminate an AWS sandbox permanently. */
export async function destroyAwsSandbox(instanceId: string): Promise<void> {
  const entry = awsRegistry.get(instanceId);
  if (entry) {
    await entry.instance.terminate();
    awsRegistry.delete(instanceId);
  } else {
    // Instance not in registry — try terminating directly
    const config = getAwsConfig();
    const ec2 = createEc2Client(config.defaultRegion, getEc2Credentials());
    await terminateInstance(ec2, instanceId);
  }
}

// ---------------------------------------------------------------------------
// Garbage collector for AWS instances
// ---------------------------------------------------------------------------

const AWS_GC_INTERVAL_MS = 60_000;
const AWS_ARCHIVE_DESTROY_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Start the GC loop for AWS instances.
 *
 * - Running instances past their TTL → Stop (preserve EBS)
 * - Stopped instances past archive timeout → Terminate
 */
export function startAwsGarbageCollector(): () => void {
  const interval = setInterval(async () => {
    const now = Date.now();

    for (const [instanceId, entry] of awsRegistry) {
      try {
        // Check if running instance has exceeded TTL → stop it
        if (!entry.stoppedAt && now - entry.createdAt > entry.ttlMs) {
          console.log(`[aws-gc] Stopping instance ${instanceId} (TTL exceeded)`);
          await entry.instance.stop();
          entry.stoppedAt = now;
        }

        // Check if stopped instance has exceeded archive timeout → terminate
        if (entry.stoppedAt && now - entry.stoppedAt > AWS_ARCHIVE_DESTROY_MS) {
          console.log(`[aws-gc] Terminating instance ${instanceId} (archive timeout)`);
          await entry.instance.terminate();
          awsRegistry.delete(instanceId);
        }
      } catch (error) {
        console.error(`[aws-gc] Failed to process instance ${instanceId}:`, error);
      }
    }
  }, AWS_GC_INTERVAL_MS);

  return () => clearInterval(interval);
}

// ---------------------------------------------------------------------------
// Snapshot operations
// ---------------------------------------------------------------------------

export async function createAwsSnapshot(
  instanceId: string,
  name: string,
): Promise<string> {
  const entry = awsRegistry.get(instanceId);
  if (!entry) {
    throw new Error(`AWS instance ${instanceId} not found in registry`);
  }

  const ec2 = createEc2Client(entry.instance.region, getEc2Credentials());
  return createAmi(ec2, instanceId, name);
}

export async function listAwsSnapshots(): Promise<
  Array<{ imageId: string; name: string; createdAt: string; state: string }>
> {
  const config = getAwsConfig();
  const ec2 = createEc2Client(config.defaultRegion, getEc2Credentials());
  return listAmis(ec2);
}

export async function deleteAwsSnapshot(imageId: string): Promise<void> {
  const config = getAwsConfig();
  const ec2 = createEc2Client(config.defaultRegion, getEc2Credentials());
  await deregisterAmi(ec2, imageId);
}
