import {
  getAccessTokenFromRequest,
  getUserFromRequest,
} from "@/lib/utils/auth";
import { selectGitIdentity } from "@/lib/utils/gitIdentity";
import { stackServerAppJs } from "@/lib/utils/stack";
import { verifyTeamAccess } from "@/lib/utils/team-verification";
import { env } from "@/lib/utils/www-env";
import { getDb } from "@cmux/db";
import { getApiKeysForAgents } from "@cmux/db/queries/settings";
import { getEnvironmentByTeam } from "@cmux/db/queries/environments";
import { getWorkspaceConfig } from "@cmux/db/queries/settings";
import { getTaskRunById, getTaskRunByContainerName } from "@cmux/db/queries/task-runs";
import { listTeamMemberships } from "@cmux/db/queries/teams";
import {
  updateTaskRunVSCode,
  updateTaskRunVSCodeStatus,
  updateTaskRunNetworking,
} from "@cmux/db/mutations/task-runs";
import {
  claimInstance,
  createPrewarmEntry,
  markInstanceReady,
  markInstanceFailed,
} from "@cmux/db/mutations/warm-pool";
import { recordResume } from "@cmux/db/mutations/morph-instances";
import { DEFAULT_MORPH_SNAPSHOT_ID } from "@/lib/utils/morph-defaults";
import { RESERVED_CMUX_PORT_SET } from "@cmux/shared/utils/reserved-cmux-ports";
import { parseGithubRepoUrl } from "@cmux/shared/utils/parse-github-repo-url";
import { parseGitUrl } from "@cmux/shared/utils/parse-git-url";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";
import { type Instance, MorphCloudClient } from "morphcloud";
import { loadEnvironmentEnvVars } from "./sandboxes/environment";
import {
  configureGithubAccess,
  configureGitIdentity,
  fetchGitIdentityInputs,
} from "./sandboxes/git";
import type { HydrateRepoConfig } from "./sandboxes/hydration";
import { hydrateWorkspace } from "./sandboxes/hydration";
import { resolveTeamAndSnapshot } from "./sandboxes/snapshot";
import {
  allocateScriptIdentifiers,
  runMaintenanceAndDevScripts,
} from "./sandboxes/startDevAndMaintenanceScript";
import {
  encodeEnvContentForEnvctl,
  envctlLoadCommand,
} from "./utils/ensure-env-vars";
import { VM_CLEANUP_COMMANDS } from "./sandboxes/cleanup";
import { startDockerSandbox } from "./sandboxes/docker-provider";
import {
  startIncusSandbox,
  listProviderSnapshots,
  deleteProviderSnapshot,
  RemoteIncusSandboxInstance,
} from "./sandboxes/incus-provider";
import { sendProviderRequest } from "@/lib/utils/provider-client";
import { getOnlineByCapability } from "@cmux/db/queries/providers";
import { injectClaudeCredentials, injectClaudeAuth } from "./sandboxes/claude-credentials";
import { injectHostSshKeys } from "./sandboxes/ssh-keys";

// Track running Incus containers for snapshot operations.
// State now also lives in the provider daemon, but we keep a local map
// for quick lookups without round-trips during the same session.
export const incusVmRegistry = new Map<string, RemoteIncusSandboxInstance>();

/**
 * Resolve the providerId for Incus operations. Falls back to the first online
 * provider with compute:incus capability.
 */
function resolveIncusProviderId(
  db: ReturnType<typeof getDb>,
  teamSlugOrId: string,
  vscode?: Record<string, unknown> | null,
): string | null {
  // Try providerId from vscode metadata
  if (vscode?.providerId) return vscode.providerId as string;

  // Find first online provider with compute:incus capability
  const providers = getOnlineByCapability(db, teamSlugOrId, "compute:incus");
  return providers[0]?.id ?? null;
}

/**
 * Wait for the VSCode server to be ready by polling the service URL.
 * This prevents "upstream connect error" when the iframe loads before the server is ready.
 */
async function waitForVSCodeReady(
  vscodeUrl: string,
  options: { timeoutMs?: number; intervalMs?: number } = {}
): Promise<boolean> {
  const { timeoutMs = 15_000, intervalMs = 500 } = options;
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    try {
      // Use a simple HEAD request to check if the server is responding
      const response = await fetch(vscodeUrl, {
        method: "HEAD",
        signal: AbortSignal.timeout(3_000),
      });
      // OpenVSCode server returns 200 for the root path when ready
      if (response.ok || response.status === 302 || response.status === 301) {
        return true;
      }
    } catch {
      // Connection refused or timeout - server not ready yet
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  return false;
}

/**
 * Extract a safe, descriptive error message from sandbox start errors.
 * Avoids leaking sensitive information like API keys, tokens, or internal paths.
 */
function getSandboxStartErrorMessage(error: unknown): string {
  const baseMessage = "Failed to start sandbox";

  if (!(error instanceof Error)) {
    return baseMessage;
  }

  const message = error.message.toLowerCase();

  // Check for common error patterns and provide helpful context
  // Network/connectivity issues
  if (message.includes("timeout") || message.includes("timed out")) {
    return `${baseMessage}: request timed out while provisioning instance`;
  }
  if (message.includes("econnrefused") || message.includes("connection refused")) {
    return `${baseMessage}: could not connect to sandbox provider`;
  }
  if (message.includes("enotfound") || message.includes("getaddrinfo")) {
    return `${baseMessage}: could not resolve sandbox provider address`;
  }
  if (message.includes("network") || message.includes("socket")) {
    return `${baseMessage}: network error while provisioning instance`;
  }

  // Quota/resource issues (common with cloud providers)
  if (message.includes("quota") || message.includes("limit") || message.includes("exceeded")) {
    return `${baseMessage}: resource quota exceeded`;
  }
  if (message.includes("capacity") || message.includes("unavailable")) {
    return `${baseMessage}: sandbox provider capacity unavailable`;
  }

  // Snapshot issues
  if (message.includes("snapshot") && (message.includes("not found") || message.includes("invalid"))) {
    return `${baseMessage}: snapshot not found or invalid`;
  }

  // Authentication/authorization (without revealing details)
  if (message.includes("unauthorized") || message.includes("401")) {
    return `${baseMessage}: authentication failed with sandbox provider`;
  }
  if (message.includes("forbidden") || message.includes("403")) {
    return `${baseMessage}: access denied by sandbox provider`;
  }

  // Rate limiting
  if (message.includes("rate limit") || message.includes("429") || message.includes("too many")) {
    return `${baseMessage}: rate limited by sandbox provider`;
  }

  // Instance startup issues
  if (message.includes("instance") && message.includes("start")) {
    return `${baseMessage}: instance failed to start`;
  }

  // If error message is reasonably safe (no obvious secrets patterns), include part of it
  const sensitivePatterns = [
    /api[_-]?key/i,
    /token/i,
    /secret/i,
    /password/i,
    /credential/i,
    /bearer/i,
    /authorization/i,
    /sk[_-][a-z0-9]/i,
    /pk[_-][a-z0-9]/i,
  ];

  const hasSensitiveContent = sensitivePatterns.some((pattern) =>
    pattern.test(error.message)
  );

  if (!hasSensitiveContent && error.message.length < 200) {
    // Sanitize the message: remove potential file paths and URLs
    const sanitized = error.message
      .replace(/\/[^\s]+/g, "[path]") // Replace file paths
      .replace(/https?:\/\/[^\s]+/g, "[url]") // Replace URLs
      .trim();

    if (sanitized.length > 0 && sanitized !== "[path]" && sanitized !== "[url]") {
      return `${baseMessage}: ${sanitized}`;
    }
  }

  return baseMessage;
}

/**
 * Cmux instance metadata stored in Morph instance.metadata
 */
interface CmuxInstanceMetadata {
  app?: string;
  userId?: string;
  teamId?: string;
}

/**
 * Result of instance ownership verification
 */
type VerifyInstanceOwnershipResult =
  | { authorized: true; instanceId: string }
  | { authorized: false; status: 403 | 404; message: string };

/**
 * Verify that a user owns or has team access to a Morph instance.
 * Checks instance metadata for cmux app prefix and user/team ownership.
 */
async function verifyInstanceOwnership(
  morphClient: MorphCloudClient,
  instanceId: string,
  userId: string,
  checkTeamMembership: () => Promise<{ teamId: string }[]>
): Promise<VerifyInstanceOwnershipResult> {
  let instance;
  try {
    instance = await morphClient.instances.get({ instanceId });
  } catch {
    return { authorized: false, status: 404, message: "Instance not found" };
  }

  const meta = instance.metadata as CmuxInstanceMetadata | undefined;

  // Verify the instance belongs to cmux (accepts cmux, cmux-dev, cmux-preview, etc.)
  if (!meta?.app?.startsWith("cmux")) {
    return { authorized: false, status: 404, message: "Instance not found" };
  }

  // Check direct ownership
  const isOwner = meta.userId === userId;
  if (isOwner) {
    return { authorized: true, instanceId };
  }

  // Check team membership if instance has a teamId
  if (meta.teamId) {
    try {
      const memberships = await checkTeamMembership();
      const isTeamMember = memberships.some((m) => m.teamId === meta.teamId);
      if (isTeamMember) {
        return { authorized: true, instanceId };
      }
    } catch {
      // Failed to check team membership - continue to deny
    }
  }

  return {
    authorized: false,
    status: 403,
    message: "Forbidden - not authorized to access this instance",
  };
}

export const sandboxesRouter = new OpenAPIHono();

const StartSandboxBody = z
  .object({
    teamSlugOrId: z.string(),
    environmentId: z.string().optional(),
    snapshotId: z.string().optional(),
    provider: z.enum(["morph", "docker", "incus"]).optional(),
    ttlSeconds: z
      .number()
      .optional()
      .default(60 * 60),
    metadata: z.record(z.string(), z.string()).optional(),
    taskRunId: z.string().optional(),
    taskRunJwt: z.string().optional(),
    isCloudWorkspace: z.boolean().optional(),
    // Optional hydration parameters to clone a repo into the sandbox on start
    repoUrl: z.string().optional(),
    branch: z.string().optional(),
    newBranch: z.string().optional(),
    depth: z.number().optional().default(1),
    displays: z.array(z.enum(["android"])).optional(),
  })
  .openapi("StartSandboxBody");

const StartSandboxResponse = z
  .object({
    instanceId: z.string(),
    vscodeUrl: z.string(),
    workerUrl: z.string(),
    provider: z.enum(["morph", "docker", "incus"]).default("morph"),
    vscodePersisted: z.boolean().optional(),
  })
  .openapi("StartSandboxResponse");

const UpdateSandboxEnvBody = z
  .object({
    teamSlugOrId: z.string(),
    envVarsContent: z.string(),
  })
  .openapi("UpdateSandboxEnvBody");

const UpdateSandboxEnvResponse = z
  .object({
    applied: z.literal(true),
  })
  .openapi("UpdateSandboxEnvResponse");

// Start a new sandbox (currently Morph-backed)
sandboxesRouter.openapi(
  createRoute({
    method: "post" as const,
    path: "/sandboxes/start",
    tags: ["Sandboxes"],
    summary: "Start a sandbox environment",
    request: {
      body: {
        content: {
          "application/json": {
            schema: StartSandboxBody,
          },
        },
        required: true,
      },
    },
    responses: {
      200: {
        content: {
          "application/json": {
            schema: StartSandboxResponse,
          },
        },
        description: "Sandbox started successfully",
      },
      401: { description: "Unauthorized" },
      500: { description: "Failed to start sandbox" },
    },
  }),
  async (c) => {
    const user = await getUserFromRequest(c.req.raw);
    if (!user) {
      return c.text("Unauthorized", 401);
    }
    const db = getDb();
    const githubAccessTokenPromise = (async () => {
      const githubAccount = await user.getConnectedAccount("github");
      if (!githubAccount) {
        return {
          githubAccessTokenError: "GitHub account not found",
          githubAccessToken: null,
        } as const;
      }
      const { accessToken: githubAccessToken } =
        await githubAccount.getAccessToken();
      if (!githubAccessToken) {
        return {
          githubAccessTokenError: "GitHub access token not found",
          githubAccessToken: null,
        } as const;
      }

      return { githubAccessTokenError: null, githubAccessToken } as const;
    })();

    // Shared API keys promise — used for GITHUB_PAT fallback and Claude credentials
    const apiKeysPromise = (async () => {
      try {
        return getApiKeysForAgents(db, c.req.valid("json").teamSlugOrId, user.id);
      } catch (error) {
        console.error(`[sandboxes.start] Failed to fetch API keys:`, error);
        return {} as Record<string, string>;
      }
    })();

    const body = c.req.valid("json");
    try {
      console.log("[sandboxes.start] incoming", {
        teamSlugOrId: body.teamSlugOrId,
        hasEnvId: Boolean(body.environmentId),
        hasSnapshotId: Boolean(body.snapshotId),
        repoUrl: body.repoUrl,
        branch: body.branch,
      });
    } catch {
      /* noop */
    }

    try {
      const {
        team,
        resolvedSnapshotId,
        environmentDataVaultKey,
        environmentMaintenanceScript,
        environmentDevScript,
      } = await resolveTeamAndSnapshot({
        req: c.req.raw,
        teamSlugOrId: body.teamSlugOrId,
        environmentId: body.environmentId,
        snapshotId: body.snapshotId,
      });

      const environmentEnvVarsPromise = environmentDataVaultKey
        ? loadEnvironmentEnvVars(environmentDataVaultKey)
        : Promise.resolve<string | null>(null);

      // Parse repo URL once if provided
      const parsedRepoUrl = body.repoUrl ? parseGithubRepoUrl(body.repoUrl) : null;

      // Load workspace config if we're in cloud mode with a repository (not an environment)
      let workspaceConfig: { maintenanceScript?: string; envVarsContent?: string } | null = null;
      if (parsedRepoUrl && !body.environmentId) {
        try {
          const config = getWorkspaceConfig(
            db,
            body.teamSlugOrId,
            user.id,
            parsedRepoUrl.fullName,
          );
          if (config) {
            const envVarsContent = config.dataVaultKey
              ? await loadEnvironmentEnvVars(config.dataVaultKey)
              : null;
            workspaceConfig = {
              maintenanceScript: config.maintenanceScript ?? undefined,
              envVarsContent: envVarsContent ?? undefined,
            };
            console.log(`[sandboxes.start] Loaded workspace config for ${parsedRepoUrl.fullName}`, {
              hasMaintenanceScript: Boolean(workspaceConfig.maintenanceScript),
              hasEnvVars: Boolean(workspaceConfig.envVarsContent),
            });
          }
        } catch (error) {
          console.error(`[sandboxes.start] Failed to load workspace config for ${parsedRepoUrl.fullName}`, error);
        }
      }

      const maintenanceScript = environmentMaintenanceScript ?? workspaceConfig?.maintenanceScript ?? null;
      const devScript = environmentDevScript ?? null;

      const isCloudWorkspace =
        body.isCloudWorkspace !== undefined
          ? body.isCloudWorkspace
          : !body.taskRunId;

      const scriptIdentifiers =
        maintenanceScript || devScript
          ? allocateScriptIdentifiers()
          : null;

      const gitIdentityPromise = githubAccessTokenPromise.then(
        ({ githubAccessToken }) => {
          if (!githubAccessToken) {
            throw new Error("GitHub access token not found");
          }
          return fetchGitIdentityInputs(user.id, githubAccessToken);
        },
      );
      // Prevent unhandled rejection — actual error handling happens in consumers below
      gitIdentityPromise.catch(() => {});

      // --- Resolve provider ---
      // If an environment is specified and it uses a provider, override the provider
      let resolvedProvider = body.provider ?? env.SANDBOX_PROVIDER ?? "morph";
      let environmentSnapshotId: string | undefined;
      let resolvedProviderId: string | undefined;
      if (body.environmentId && !body.provider) {
        try {
          const envDoc = getEnvironmentByTeam(
            db,
            body.teamSlugOrId,
            body.environmentId,
          );
          if (envDoc?.providerId) {
            // Environment is linked to a unified provider
            resolvedProvider = "incus";
            resolvedProviderId = envDoc.providerId;
            environmentSnapshotId = envDoc.snapshotId ?? envDoc.incusSnapshotId ?? undefined;
          } else if (envDoc?.provider === "incus") {
            // Legacy: environment uses old provider column
            resolvedProvider = "incus";
            environmentSnapshotId = envDoc.incusSnapshotId ?? undefined;
          }
        } catch (lookupErr) {
          console.warn("[sandboxes.start] Failed to look up environment provider:", lookupErr);
        }
      }
      // If incus provider selected but no providerId yet, find one
      if (resolvedProvider === "incus" && !resolvedProviderId) {
        const onlineProviders = getOnlineByCapability(db, body.teamSlugOrId, "compute:incus");
        if (onlineProviders.length > 0) {
          resolvedProviderId = onlineProviders[0].id;
        }
      }

      // --- Docker provider path ---
      if (resolvedProvider === "docker") {
        console.log(`[sandboxes.start] Using Docker provider`);

        const dockerResult = await startDockerSandbox({
          ttlSeconds: body.ttlSeconds ?? 3600,
          metadata: body.metadata,
        });

        // Wait for VSCode server to be ready
        const vscodeReady = await waitForVSCodeReady(dockerResult.vscodeUrl, {
          timeoutMs: 30_000,
        });
        if (!vscodeReady) {
          console.warn(
            `[sandboxes.start] Docker VSCode server did not become ready within timeout for ${dockerResult.containerId}, proceeding anyway`,
          );
        }

        // Persist VSCode info to DB
        let vscodePersisted = false;
        if (body.taskRunId) {
          try {
            updateTaskRunVSCode(db, body.taskRunId, {
              provider: "docker",
              containerName: dockerResult.containerName,
              status: "starting",
              url: dockerResult.vscodeUrl,
              workspaceUrl: `${dockerResult.vscodeUrl}/?folder=/root/workspace`,
              startedAt: Date.now(),
              ports: {
                vscode: dockerResult.hostPorts[39378],
                worker: dockerResult.hostPorts[39377],
                proxy: dockerResult.hostPorts[39379],
                vnc: dockerResult.hostPorts[39380],
                pty: dockerResult.hostPorts[39383],
              },
            });
            vscodePersisted = true;
          } catch (error) {
            console.error(
              "[sandboxes.start] Failed to persist Docker VSCode info:",
              error,
            );
          }
        }

        // Apply env vars, git config, hydration — same as Morph path
        const environmentEnvVarsContent = await environmentEnvVarsPromise;
        let envVarsToApply =
          environmentEnvVarsContent || workspaceConfig?.envVarsContent || "";
        if (body.taskRunId) {
          envVarsToApply += `\nCMUX_TASK_RUN_ID="${body.taskRunId}"`;
        }
        if (body.taskRunJwt) {
          envVarsToApply += `\nCMUX_TASK_RUN_JWT="${body.taskRunJwt}"`;
        }

        const [{ githubAccessToken }, userApiKeys] =
          await Promise.all([githubAccessTokenPromise, apiKeysPromise]);

        const effectiveGithubToken = githubAccessToken || userApiKeys.GITHUB_PAT || null;
        const dockerClaudeCredentials = userApiKeys.CLAUDE_CREDENTIALS_JSON;

        const dockerInstance = dockerResult.instance;

        await Promise.all([
          // Apply env vars
          envVarsToApply.trim().length > 0
            ? (async () => {
                const encodedEnv = encodeEnvContentForEnvctl(envVarsToApply);
                const loadRes = await dockerInstance.exec(
                  envctlLoadCommand(encodedEnv),
                );
                if (loadRes.exit_code === 0) {
                  console.log(
                    `[sandboxes.start] Applied environment variables via envctl (docker)`,
                  );
                } else {
                  console.error(
                    `[sandboxes.start] Docker env var bootstrap failed exit=${loadRes.exit_code}`,
                  );
                }
              })()
            : Promise.resolve(),
          // Configure GitHub access (OAuth token or PAT fallback)
          effectiveGithubToken
            ? configureGithubAccess(dockerInstance, effectiveGithubToken)
            : Promise.resolve(),
          // Inject Claude credentials (.credentials.json for MCP OAuth tokens)
          dockerClaudeCredentials
            ? injectClaudeCredentials(dockerInstance, dockerClaudeCredentials).catch((error) => {
                console.log(
                  `[sandboxes.start] Failed to inject Claude credentials (docker); continuing...`,
                  error,
                );
              })
            : Promise.resolve(),
          // Configure git identity
          gitIdentityPromise
            .then(([who, gh]) => {
              const { name, email } = selectGitIdentity(who, gh);
              return configureGitIdentity(dockerInstance, { name, email });
            })
            .catch((error) => {
              console.log(
                `[sandboxes.start] Failed to configure git identity; continuing...`,
                error,
              );
            }),
          // Inject Claude auth (OAuth token or API key) for manual terminal use
          injectClaudeAuth(dockerInstance, userApiKeys).catch((error) => {
            console.log(
              `[sandboxes.start] Failed to inject Claude auth (docker); continuing...`,
              error,
            );
          }),
        ]);

        // Hydrate repo if requested
        if (body.repoUrl) {
          if (!parsedRepoUrl) {
            return c.text("Unsupported repo URL; expected GitHub URL", 400);
          }
          try {
            await hydrateWorkspace({
              instance: dockerInstance,
              repo: {
                owner: parsedRepoUrl.owner,
                name: parsedRepoUrl.repo,
                repoFull: parsedRepoUrl.fullName,
                cloneUrl: parsedRepoUrl.gitUrl,
                maskedCloneUrl: parsedRepoUrl.gitUrl,
                depth: Math.max(1, Math.floor(body.depth ?? 1)),
                baseBranch: body.branch || "main",
                newBranch: body.newBranch ?? "",
              },
            });
          } catch (error) {
            console.error(`[sandboxes.start] Docker hydration failed:`, error);
            await dockerInstance.stop().catch(() => {});
            return c.text("Failed to hydrate sandbox", 500);
          }
        }

        // Update status to running
        if (body.taskRunId && vscodePersisted) {
          try {
            updateTaskRunVSCodeStatus(db, body.taskRunId, "running");
          } catch (error) {
            console.error(
              "[sandboxes.start] Failed to update Docker VSCode status:",
              error,
            );
          }
        }

        // Run maintenance/dev scripts if configured
        if (maintenanceScript || devScript) {
          (async () => {
            await runMaintenanceAndDevScripts({
              instance: dockerInstance,
              maintenanceScript: maintenanceScript || undefined,
              devScript: devScript || undefined,
              identifiers: scriptIdentifiers ?? undefined,
              convexUrl: env.NEXT_PUBLIC_CONVEX_URL,
              taskRunJwt: body.taskRunJwt || undefined,
              isCloudWorkspace,
            });
          })().catch((error) => {
            console.error(
              "[sandboxes.start] Docker background script execution failed:",
              error,
            );
          });
        }

        return c.json({
          instanceId: dockerResult.containerId,
          vscodeUrl: dockerResult.vscodeUrl,
          workerUrl: dockerResult.workerUrl,
          provider: "docker" as const,
          vscodePersisted,
        });
      }

      // --- Incus provider path ---
      if (resolvedProvider === "incus") {
        if (!resolvedProviderId) {
          return c.json({
            code: 409,
            message: "No online Incus provider available. Register a provider in Settings.",
          }, 409);
        }

        console.log(`[sandboxes.start] Using Incus provider ${resolvedProviderId}`);

        const incusResult = await startIncusSandbox({
          providerId: resolvedProviderId,
          snapshotId: body.snapshotId ?? environmentSnapshotId,
          ttlSeconds: body.ttlSeconds ?? 3600,
          metadata: body.metadata,
          displays: body.displays,
        });

        // Register in container registry immediately for snapshot operations
        const incusInstance = incusResult.instance;
        incusVmRegistry.set(incusResult.containerId, incusInstance);

        const incusContainerId = incusResult.containerId;
        const incusVscodeUrl = incusResult.vscodeUrl;

        // Persist VSCode info to Convex BEFORE returning response so the
        // server (agentSpawner) sees vscodePersisted=true and skips its own
        // persistence (which would lack port data).
        let vscodePersisted = false;
        if (body.taskRunId) {
          try {
            updateTaskRunVSCode(db, body.taskRunId, {
              provider: "incus",
              containerName: incusContainerId,
              providerId: resolvedProviderId,
              status: "starting",
              url: incusVscodeUrl,
              workspaceUrl: `${incusVscodeUrl}/?folder=/root/workspace`,
              startedAt: Date.now(),
              ports: {
                vscode: incusResult.hostPorts[39378],
                worker: incusResult.hostPorts[39377],
                proxy: incusResult.hostPorts[39379],
                vnc: incusResult.hostPorts[39380],
                pty: incusResult.hostPorts[39383],
                ...(incusResult.hostPorts[39384]
                  ? { androidVnc: incusResult.hostPorts[39384] }
                  : {}),
              },
            });
            vscodePersisted = true;
          } catch (error) {
            console.error(
              "[sandboxes.start] Failed to persist Incus VSCode info:",
              error,
            );
          }
        }

        // Fire-and-forget: background provisioning (env vars, git config, repo clone, scripts)
        (async () => {
          try {
            // Wait for VSCode server to be ready
            const vscodeReady = await waitForVSCodeReady(incusVscodeUrl, {
              timeoutMs: 30_000,
            });
            if (!vscodeReady) {
              console.warn(
                `[sandboxes.start] Incus VSCode server did not become ready within timeout for ${incusContainerId}, proceeding anyway`,
              );
            }

            // Apply env vars, git config, hydration
            const environmentEnvVarsContent = await environmentEnvVarsPromise;
            let envVarsToApply =
              environmentEnvVarsContent || workspaceConfig?.envVarsContent || "";
            if (body.taskRunId) {
              envVarsToApply += `\nCMUX_TASK_RUN_ID="${body.taskRunId}"`;
            }
            if (body.taskRunJwt) {
              envVarsToApply += `\nCMUX_TASK_RUN_JWT="${body.taskRunJwt}"`;
            }

            const [{ githubAccessToken: incusGithubToken }, incusApiKeys] =
              await Promise.all([githubAccessTokenPromise, apiKeysPromise]);

            const effectiveIncusGithubToken = incusGithubToken || incusApiKeys.GITHUB_PAT || null;
            const claudeCredentialsValue = incusApiKeys.CLAUDE_CREDENTIALS_JSON;

            await Promise.all([
              envVarsToApply.trim().length > 0
                ? (async () => {
                    const encodedEnv = encodeEnvContentForEnvctl(envVarsToApply);
                    const loadRes = await incusInstance.exec(
                      envctlLoadCommand(encodedEnv),
                    );
                    if (loadRes.exit_code === 0) {
                      console.log(
                        `[sandboxes.start] Applied environment variables via envctl (incus)`,
                      );
                    } else {
                      console.error(
                        `[sandboxes.start] Incus env var bootstrap failed exit=${loadRes.exit_code}`,
                      );
                    }
                  })()
                : Promise.resolve(),
              effectiveIncusGithubToken
                ? configureGithubAccess(incusInstance, effectiveIncusGithubToken)
                : Promise.resolve(),
              gitIdentityPromise
                .then(([who, gh]) => {
                  const { name, email } = selectGitIdentity(who, gh);
                  return configureGitIdentity(incusInstance, { name, email });
                })
                .catch((error) => {
                  console.log(
                    `[sandboxes.start] Failed to configure git identity; continuing...`,
                    error,
                  );
                }),
              injectHostSshKeys(incusInstance).catch((error) => {
                console.log(
                  `[sandboxes.start] Failed to inject SSH keys; continuing...`,
                  error,
                );
              }),
              claudeCredentialsValue
                ? injectClaudeCredentials(incusInstance, claudeCredentialsValue).catch((error) => {
                    console.log(
                      `[sandboxes.start] Failed to inject Claude credentials; continuing...`,
                      error,
                    );
                  })
                : Promise.resolve(),
              injectClaudeAuth(incusInstance, incusApiKeys).catch((error) => {
                console.log(
                  `[sandboxes.start] Failed to inject Claude auth; continuing...`,
                  error,
                );
              }),
            ]);

            // Hydrate repo if requested
            if (body.repoUrl) {
              const incusParsedRepo = parseGitUrl(body.repoUrl);
              if (incusParsedRepo) {
                await hydrateWorkspace({
                  instance: incusInstance,
                  repo: {
                    owner: incusParsedRepo.owner,
                    name: incusParsedRepo.repo,
                    repoFull: incusParsedRepo.fullName,
                    cloneUrl: incusParsedRepo.cloneUrl,
                    maskedCloneUrl: incusParsedRepo.cloneUrl,
                    depth: Math.max(1, Math.floor(body.depth ?? 1)),
                    baseBranch: body.branch || "main",
                    newBranch: body.newBranch ?? "",
                  },
                });
              }
            }

            // Update status to running
            if (body.taskRunId && vscodePersisted) {
              try {
                updateTaskRunVSCodeStatus(db, body.taskRunId, "running");
              } catch (error) {
                console.error(
                  "[sandboxes.start] Failed to update Incus VSCode status:",
                  error,
                );
              }
            }

            // Run maintenance/dev scripts if configured
            if (maintenanceScript || devScript) {
              await runMaintenanceAndDevScripts({
                instance: incusInstance,
                maintenanceScript: maintenanceScript || undefined,
                devScript: devScript || undefined,
                identifiers: scriptIdentifiers ?? undefined,
                convexUrl: env.NEXT_PUBLIC_CONVEX_URL,
                taskRunJwt: body.taskRunJwt || undefined,
                isCloudWorkspace,
              });
            }

            console.log(
              `[sandboxes.start] Incus background provisioning complete for ${incusContainerId}`,
            );
          } catch (error) {
            console.error(
              `[sandboxes.start] Incus background provisioning failed for ${incusContainerId}:`,
              error,
            );
          }
        })();

        return c.json({
          instanceId: incusContainerId,
          vscodeUrl: incusVscodeUrl,
          workerUrl: incusResult.workerUrl,
          provider: "incus" as const,
          vscodePersisted,
        });
      }

      // --- Morph provider path ---
      if (!env.MORPH_API_KEY) {
        return c.text("MORPH_API_KEY is required when using Morph provider", 500);
      }
      const client = new MorphCloudClient({ apiKey: env.MORPH_API_KEY });

      // Try to claim a prewarmed instance from the warm pool
      let instance: Instance | undefined;
      let vscodeService: { url: string; port: number } | undefined;
      let workerService: { url: string; port: number } | undefined;
      let usedWarmPool = false;
      let warmPoolRepoUrl: string | undefined;

      if (!body.environmentId) {
        try {
          const claimed = claimInstance(db, {
            teamId: team.uuid,
            repoUrl: body.repoUrl,
            taskRunId: body.taskRunId || "",
          });

          if (claimed) {
            console.log(
              `[sandboxes.start] Claimed warm pool instance ${claimed.instanceId}`,
            );
            instance = await client.instances.get({
              instanceId: claimed.instanceId,
            });
            usedWarmPool = true;
            warmPoolRepoUrl = claimed.repoUrl ?? undefined;

            void (async () => {
              await instance.setWakeOn(true, true);
            })();

            const exposed = instance.networking.httpServices;
            vscodeService = exposed.find((s) => s.port === 39378);
            workerService = exposed.find((s) => s.port === 39377);

            if (!vscodeService || !workerService) {
              console.warn(
                `[sandboxes.start] Warm pool instance ${claimed.instanceId} missing services, falling back to on-demand`,
              );
              usedWarmPool = false;
            }
          }
        } catch (error) {
          console.error(
            "[sandboxes.start] Warm pool claim failed, falling back to on-demand",
            error,
          );
        }
      }

      if (!usedWarmPool) {
        // On-demand instance creation (original path)
        instance = await client.instances.start({
          snapshotId: resolvedSnapshotId,
          ttlSeconds: body.ttlSeconds ?? 60 * 60,
          ttlAction: "pause",
          metadata: {
            app: "cmux",
            teamId: team.uuid,
            ...(body.environmentId
              ? { environmentId: body.environmentId }
              : {}),
            ...(body.metadata || {}),
          },
        });
        void (async () => {
          await instance.setWakeOn(true, true);
        })();

        // SDK bug: instances.start() returns empty httpServices array
        // Re-fetch instance to get the actual networking data
        const refreshedInstance =
          instance.networking.httpServices.length === 0
            ? await client.instances.get({ instanceId: instance.id })
            : instance;

        const exposed = refreshedInstance.networking.httpServices;
        vscodeService = exposed.find((s) => s.port === 39378);
        workerService = exposed.find((s) => s.port === 39377);
        if (!vscodeService || !workerService) {
          await instance.stop().catch(() => {});
          return c.text("VSCode or worker service not found", 500);
        }
      }

      if (!vscodeService || !workerService || !instance) {
        return c.text("VSCode or worker service not found", 500);
      }

      // --- Fast path for prewarmed instances ---
      // Skip VSCode ready check (already verified during prewarm) and run all
      // instance.exec() calls in parallel to minimize latency.
      if (usedWarmPool) {
        console.log(
          `[sandboxes.start] Fast path: warm pool instance ${instance.id}`,
        );

        // Persist VSCode info immediately (don't wait for VSCode ready check)
        let vscodePersisted = false;
        if (body.taskRunId) {
          try {
            updateTaskRunVSCode(db, body.taskRunId, {
              provider: "morph",
              containerName: instance.id,
              status: "starting",
              url: vscodeService.url,
              workspaceUrl: `${vscodeService.url}/?folder=/root/workspace`,
              startedAt: Date.now(),
            });
            vscodePersisted = true;
            console.log(
              `[sandboxes.start] Persisted VSCode info for ${body.taskRunId}`,
            );
          } catch (error) {
            console.error(
              "[sandboxes.start] Failed to persist VSCode info (non-fatal):",
              error,
            );
          }
        }

        // Prepare env vars content
        const environmentEnvVarsContent = await environmentEnvVarsPromise;
        let envVarsToApply =
          environmentEnvVarsContent ||
          workspaceConfig?.envVarsContent ||
          "";
        if (body.taskRunId) {
          envVarsToApply += `\nCMUX_TASK_RUN_ID="${body.taskRunId}"`;
        }
        if (body.taskRunJwt) {
          envVarsToApply += `\nCMUX_TASK_RUN_JWT="${body.taskRunJwt}"`;
        }

        // Run all instance config in parallel: env vars, GitHub access, git identity, persist
        const { githubAccessToken, githubAccessTokenError } =
          await githubAccessTokenPromise;
        if (githubAccessTokenError) {
          console.error(
            `[sandboxes.start] GitHub access token error: ${githubAccessTokenError}`,
          );
          return c.text("Failed to resolve GitHub credentials", 401);
        }

        await Promise.all([
          // Apply env vars
          envVarsToApply.trim().length > 0
            ? (async () => {
                const encodedEnv = encodeEnvContentForEnvctl(envVarsToApply);
                const loadRes = await instance.exec(
                  envctlLoadCommand(encodedEnv),
                );
                if (loadRes.exit_code === 0) {
                  console.log(
                    `[sandboxes.start] Applied environment variables via envctl`,
                  );
                } else {
                  console.error(
                    `[sandboxes.start] Env var bootstrap failed exit=${loadRes.exit_code}`,
                  );
                }
              })()
            : Promise.resolve(),
          // Configure GitHub access (fresh token for the user's session)
          configureGithubAccess(instance, githubAccessToken),
          // Configure git identity
          gitIdentityPromise
            .then(([who, gh]) => {
              const { name, email } = selectGitIdentity(who, gh);
              return configureGitIdentity(instance, { name, email });
            })
            .catch((error) => {
              console.log(
                `[sandboxes.start] Failed to configure git identity; continuing...`,
                error,
              );
            }),
        ]);

        // Skip hydration - repo already cloned during prewarm
        const skipHydration = warmPoolRepoUrl === body.repoUrl && !!body.repoUrl;
        if (skipHydration) {
          console.log(
            `[sandboxes.start] Skipping hydration - repo already cloned in warm pool instance ${instance.id}`,
          );
        } else if (body.repoUrl) {
          if (!parsedRepoUrl) {
            return c.text("Unsupported repo URL; expected GitHub URL", 400);
          }
          try {
            await hydrateWorkspace({
              instance,
              repo: {
                owner: parsedRepoUrl.owner,
                name: parsedRepoUrl.repo,
                repoFull: parsedRepoUrl.fullName,
                cloneUrl: parsedRepoUrl.gitUrl,
                maskedCloneUrl: parsedRepoUrl.gitUrl,
                depth: Math.max(1, Math.floor(body.depth ?? 1)),
                baseBranch: body.branch || "main",
                newBranch: body.newBranch ?? "",
              },
            });
          } catch (error) {
            console.error(`[sandboxes.start] Hydration failed:`, error);
            await instance.stop().catch(() => {});
            return c.text("Failed to hydrate sandbox", 500);
          }
        }

        // Update status + maintenance scripts (fire-and-forget)
        if (body.taskRunId && vscodePersisted) {
          try {
            updateTaskRunVSCodeStatus(db, body.taskRunId, "running");
          } catch (error) {
            console.error(
              "[sandboxes.start] Failed to update VSCode status to running:",
              error,
            );
          }
        }

        if (maintenanceScript || devScript) {
          (async () => {
            await runMaintenanceAndDevScripts({
              instance,
              maintenanceScript: maintenanceScript || undefined,
              devScript: devScript || undefined,
              identifiers: scriptIdentifiers ?? undefined,
              convexUrl: env.NEXT_PUBLIC_CONVEX_URL,
              taskRunJwt: body.taskRunJwt || undefined,
              isCloudWorkspace,
            });
          })().catch((error) => {
            console.error(
              "[sandboxes.start] Background script execution failed:",
              error,
            );
          });
        }

        return c.json({
          instanceId: instance.id,
          vscodeUrl: vscodeService.url,
          workerUrl: workerService.url,
          provider: "morph",
          vscodePersisted,
        });
      }

      // --- Regular path (on-demand instance) ---

      // Wait for VSCode server to be ready before persisting URL
      // This prevents "upstream connect error" when the frontend loads the iframe
      // before the OpenVSCode server is actually listening
      const vscodeReady = await waitForVSCodeReady(vscodeService.url, {
        timeoutMs: 15_000,
      });
      if (!vscodeReady) {
        console.warn(
          `[sandboxes.start] VSCode server did not become ready within timeout for ${instance.id}, proceeding anyway`,
        );
      } else {
        console.log(
          `[sandboxes.start] VSCode server ready for ${instance.id}`,
        );
      }

      // Persist VSCode URLs to Convex once the server is ready
      // Status is "starting" to indicate hydration is still in progress
      let vscodePersisted = false;
      if (body.taskRunId) {
        try {
          updateTaskRunVSCode(db, body.taskRunId, {
            provider: "morph",
            containerName: instance.id,
            status: "starting",
            url: vscodeService.url,
            workspaceUrl: `${vscodeService.url}/?folder=/root/workspace`,
            startedAt: Date.now(),
          });
          vscodePersisted = true;
          console.log(
            `[sandboxes.start] Persisted VSCode info for ${body.taskRunId}`,
          );
        } catch (error) {
          console.error(
            "[sandboxes.start] Failed to persist VSCode info (non-fatal):",
            error,
          );
        }
      }

      // Get environment variables from the environment if configured
      const environmentEnvVarsContent = await environmentEnvVarsPromise;

      // Prepare environment variables including task JWT if present
      // Workspace env vars take precedence if no environment is configured
      let envVarsToApply = environmentEnvVarsContent || workspaceConfig?.envVarsContent || "";

      // Add CMUX task-related env vars if present
      if (body.taskRunId) {
        envVarsToApply += `\nCMUX_TASK_RUN_ID="${body.taskRunId}"`;
      }
      if (body.taskRunJwt) {
        envVarsToApply += `\nCMUX_TASK_RUN_JWT="${body.taskRunJwt}"`;
      }

      // Apply all environment variables if any
      if (envVarsToApply.trim().length > 0) {
        try {
          const encodedEnv = encodeEnvContentForEnvctl(envVarsToApply);
          const loadRes = await instance.exec(envctlLoadCommand(encodedEnv));
          if (loadRes.exit_code === 0) {
            console.log(
              `[sandboxes.start] Applied environment variables via envctl`,
              {
                hasEnvironmentVars: Boolean(environmentEnvVarsContent),
                hasWorkspaceVars: Boolean(workspaceConfig?.envVarsContent),
                hasTaskRunId: Boolean(body.taskRunId),
                hasTaskRunJwt: Boolean(body.taskRunJwt),
              },
            );
          } else {
            console.error(
              `[sandboxes.start] Env var bootstrap failed exit=${loadRes.exit_code} stderr=${(loadRes.stderr || "").slice(0, 200)}`,
            );
          }
        } catch (error) {
          console.error(
            "[sandboxes.start] Failed to apply environment variables",
            error,
          );
        }
      }

      const configureGitIdentityTask = gitIdentityPromise
        .then(([who, gh]) => {
          const { name, email } = selectGitIdentity(who, gh);
          return configureGitIdentity(instance, { name, email });
        })
        .catch((error) => {
          console.log(
            `[sandboxes.start] Failed to configure git identity; continuing...`,
            error,
          );
        });

      const { githubAccessToken, githubAccessTokenError } =
        await githubAccessTokenPromise;
      if (githubAccessTokenError) {
        console.error(
          `[sandboxes.start] GitHub access token error: ${githubAccessTokenError}`,
        );
        return c.text("Failed to resolve GitHub credentials", 401);
      }

      // Sandboxes run as the requesting user, so prefer their OAuth scope over GitHub App installation tokens.
      await configureGithubAccess(instance, githubAccessToken);

      {
        let repoConfig: HydrateRepoConfig | undefined;
        if (body.repoUrl) {
          console.log(`[sandboxes.start] Hydrating repo for ${instance.id}`);
          if (!parsedRepoUrl) {
            return c.text("Unsupported repo URL; expected GitHub URL", 400);
          }
          console.log(`[sandboxes.start] Parsed owner/repo: ${parsedRepoUrl.fullName}`);

          repoConfig = {
            owner: parsedRepoUrl.owner,
            name: parsedRepoUrl.repo,
            repoFull: parsedRepoUrl.fullName,
            cloneUrl: parsedRepoUrl.gitUrl,
            maskedCloneUrl: parsedRepoUrl.gitUrl,
            depth: Math.max(1, Math.floor(body.depth ?? 1)),
            baseBranch: body.branch || "main",
            newBranch: body.newBranch ?? "",
          };
        }

        try {
          await hydrateWorkspace({
            instance,
            repo: repoConfig,
          });
        } catch (error) {
          console.error(`[sandboxes.start] Hydration failed:`, error);
          await instance.stop().catch(() => { });
          return c.text("Failed to hydrate sandbox", 500);
        }
      }

      // Update status to "running" after hydration completes
      if (body.taskRunId && vscodePersisted) {
        try {
          updateTaskRunVSCodeStatus(db, body.taskRunId, "running");
        } catch (error) {
          console.error(
            "[sandboxes.start] Failed to update VSCode status to running:",
            error,
          );
        }
      }

      if (maintenanceScript || devScript) {
        (async () => {
          await runMaintenanceAndDevScripts({
            instance,
            maintenanceScript: maintenanceScript || undefined,
            devScript: devScript || undefined,
            identifiers: scriptIdentifiers ?? undefined,
            convexUrl: env.NEXT_PUBLIC_CONVEX_URL,
            taskRunJwt: body.taskRunJwt || undefined,
            isCloudWorkspace,
          });
        })().catch((error) => {
          console.error(
            "[sandboxes.start] Background script execution failed:",
            error,
          );
        });
      }

      await configureGitIdentityTask;

      return c.json({
        instanceId: instance.id,
        vscodeUrl: vscodeService.url,
        workerUrl: workerService.url,
        provider: "morph",
        vscodePersisted,
      });
    } catch (error) {
      if (error instanceof HTTPException) {
        const message =
          typeof error.message === "string" && error.message.length > 0
            ? error.message
            : "Request failed";
        return c.text(message, error.status);
      }
      console.error("Failed to start sandbox:", error);
      // Provide a more descriptive error message without leaking sensitive details
      const errorMessage = getSandboxStartErrorMessage(error);
      return c.text(errorMessage, 500);
    }
  },
);

// Prewarm a sandbox instance for faster task startup
const PrewarmSandboxBody = z
  .object({
    teamSlugOrId: z.string(),
    repoUrl: z.string().optional(),
    branch: z.string().optional(),
  })
  .openapi("PrewarmSandboxBody");

const PrewarmSandboxResponse = z
  .object({
    id: z.string(),
    alreadyExists: z.boolean(),
  })
  .openapi("PrewarmSandboxResponse");

sandboxesRouter.openapi(
  createRoute({
    method: "post" as const,
    path: "/sandboxes/prewarm",
    tags: ["Sandboxes"],
    summary: "Prewarm a sandbox instance for a repo",
    description:
      "Creates a Morph instance in the background with the repo already cloned. " +
      "Call this when the user starts typing a task description for faster startup.",
    request: {
      body: {
        content: {
          "application/json": {
            schema: PrewarmSandboxBody,
          },
        },
        required: true,
      },
    },
    responses: {
      200: {
        content: {
          "application/json": {
            schema: PrewarmSandboxResponse,
          },
        },
        description: "Prewarm entry created (provisioning in background)",
      },
      401: { description: "Unauthorized" },
      500: { description: "Failed to create prewarm entry" },
    },
  }),
  async (c) => {
    const user = await stackServerAppJs.getUser({ tokenStore: c.req.raw });
    if (!user) {
      return c.text("Unauthorized", 401);
    }

    const body = c.req.valid("json");
    const db = getDb();

    try {
      const team = await verifyTeamAccess({
        req: c.req.raw,
        teamSlugOrId: body.teamSlugOrId,
      });

      const snapshotId = DEFAULT_MORPH_SNAPSHOT_ID;

      // Create or find existing prewarm entry
      const result = createPrewarmEntry(db, {
        teamId: team.uuid,
        userId: user.id,
        snapshotId,
        repoUrl: body.repoUrl,
        branch: body.branch,
      });

      if (result.alreadyExists) {
        return c.json({ id: result.id, alreadyExists: true });
      }

      // Get GitHub access token for repo cloning (needed in background)
      const githubAccountPromise = user.getConnectedAccount("github");

      // Fire-and-forget background provisioning
      const prewarmEntryId = result.id;
      (async () => {
        try {
          const client = new MorphCloudClient({ apiKey: env.MORPH_API_KEY });

          // Start Morph instance
          let instance = await client.instances.start({
            snapshotId,
            ttlSeconds: 3600,
            ttlAction: "pause",
            metadata: {
              app: "cmux-warm-pool",
              teamId: team.uuid,
              userId: user.id,
            },
          });

          void (async () => {
            await instance.setWakeOn(true, true);
          })();

          // Re-fetch for httpServices (SDK bug)
          if (instance.networking.httpServices.length === 0) {
            instance = await client.instances.get({
              instanceId: instance.id,
            });
          }

          const exposed = instance.networking.httpServices;
          const vscodeService = exposed.find((s) => s.port === 39378);
          const workerService = exposed.find((s) => s.port === 39377);

          if (!vscodeService || !workerService) {
            throw new Error(
              `VSCode or worker service not found on instance ${instance.id}`
            );
          }

          // Wait for VSCode to be ready
          await waitForVSCodeReady(vscodeService.url, { timeoutMs: 30_000 });

          // Configure GitHub access for repo cloning
          const githubAccount = await githubAccountPromise;
          if (githubAccount) {
            const { accessToken: ghToken } =
              await githubAccount.getAccessToken();
            if (ghToken) {
              await configureGithubAccess(instance, ghToken);
            }
          }

          // Clone the repo if provided
          if (body.repoUrl) {
            const parsed = parseGithubRepoUrl(body.repoUrl);
            if (parsed) {
              await hydrateWorkspace({
                instance,
                repo: {
                  owner: parsed.owner,
                  name: parsed.repo,
                  repoFull: parsed.fullName,
                  cloneUrl: parsed.gitUrl,
                  maskedCloneUrl: parsed.gitUrl,
                  depth: 1,
                  baseBranch: body.branch || "main",
                  newBranch: "",
                },
              });
            }
          }

          // Mark as ready in the warm pool
          markInstanceReady(db, {
            id: prewarmEntryId,
            instanceId: instance.id,
            vscodeUrl: vscodeService.url,
            workerUrl: workerService.url,
          });

          console.log(
            `[sandboxes.prewarm] Instance ${instance.id} ready with repo ${body.repoUrl ?? "none"}`
          );
        } catch (error) {
          console.error("[sandboxes.prewarm] Background provisioning failed:", error);
          try {
            markInstanceFailed(db, {
              id: prewarmEntryId,
              errorMessage:
                error instanceof Error ? error.message : String(error),
            });
          } catch (markError) {
            console.error(
              "[sandboxes.prewarm] Failed to mark entry as failed:",
              markError
            );
          }
        }
      })();

      return c.json({ id: result.id, alreadyExists: false });
    } catch (error) {
      console.error("[sandboxes.prewarm] Failed:", error);
      return c.text("Failed to create prewarm entry", 500);
    }
  }
);

sandboxesRouter.openapi(
  createRoute({
    method: "post" as const,
    path: "/sandboxes/{id}/env",
    tags: ["Sandboxes"],
    summary: "Apply environment variables to a running sandbox",
    request: {
      params: z.object({ id: z.string() }),
      body: {
        content: {
          "application/json": {
            schema: UpdateSandboxEnvBody,
          },
        },
        required: true,
      },
    },
    responses: {
      200: {
        content: {
          "application/json": {
            schema: UpdateSandboxEnvResponse,
          },
        },
        description: "Environment variables applied",
      },
      401: { description: "Unauthorized" },
      403: { description: "Forbidden" },
      404: { description: "Sandbox not found" },
      500: { description: "Failed to apply environment variables" },
    },
  }),
  async (c) => {
    const accessToken = await getAccessTokenFromRequest(c.req.raw);
    if (!accessToken) return c.text("Unauthorized", 401);

    const { id } = c.req.valid("param");
    const { teamSlugOrId, envVarsContent } = c.req.valid("json");

    try {
      const team = await verifyTeamAccess({
        req: c.req.raw,
        teamSlugOrId,
      });

      const client = new MorphCloudClient({ apiKey: env.MORPH_API_KEY });
      const instance = await client.instances
        .get({ instanceId: id })
        .catch((error) => {
          console.error("[sandboxes.env] Failed to load instance", error);
          return null;
        });

      if (!instance) {
        return c.text("Sandbox not found", 404);
      }

      const metadataTeamId = (
        instance as unknown as {
          metadata?: { teamId?: string };
        }
      ).metadata?.teamId;

      if (metadataTeamId && metadataTeamId !== team.uuid) {
        return c.text("Forbidden", 403);
      }

      const encodedEnv = encodeEnvContentForEnvctl(envVarsContent);
      const command = envctlLoadCommand(encodedEnv);
      const execResult = await instance.exec(command);
      if (execResult.exit_code !== 0) {
        console.error(
          `[sandboxes.env] envctl load failed exit=${execResult.exit_code} stderr=${(execResult.stderr || "").slice(0, 200)}`,
        );
        return c.text("Failed to apply environment variables", 500);
      }

      return c.json({ applied: true as const });
    } catch (error) {
      console.error(
        "[sandboxes.env] Failed to apply environment variables",
        error,
      );
      return c.text("Failed to apply environment variables", 500);
    }
  },
);

// Run maintenance and dev scripts in a sandbox
const RunScriptsBody = z
  .object({
    teamSlugOrId: z.string(),
    maintenanceScript: z.string().optional(),
    devScript: z.string().optional(),
  })
  .openapi("RunScriptsBody");

const RunScriptsResponse = z
  .object({
    started: z.literal(true),
  })
  .openapi("RunScriptsResponse");

sandboxesRouter.openapi(
  createRoute({
    method: "post" as const,
    path: "/sandboxes/{id}/run-scripts",
    tags: ["Sandboxes"],
    summary: "Run maintenance and dev scripts in a sandbox",
    description:
      "Runs maintenance and/or dev scripts in tmux sessions within the sandbox. " +
      "This ensures scripts run in a managed way that can be properly cleaned up before snapshotting.",
    request: {
      params: z.object({ id: z.string() }),
      body: {
        content: {
          "application/json": {
            schema: RunScriptsBody,
          },
        },
        required: true,
      },
    },
    responses: {
      200: {
        content: {
          "application/json": {
            schema: RunScriptsResponse,
          },
        },
        description: "Scripts started successfully",
      },
      401: { description: "Unauthorized" },
      403: { description: "Forbidden" },
      404: { description: "Sandbox not found" },
      500: { description: "Failed to run scripts" },
    },
  }),
  async (c) => {
    const accessToken = await getAccessTokenFromRequest(c.req.raw);
    if (!accessToken) return c.text("Unauthorized", 401);

    const { id } = c.req.valid("param");
    const { teamSlugOrId, maintenanceScript, devScript } = c.req.valid("json");

    // Need at least one script to run
    if (!maintenanceScript && !devScript) {
      return c.json({ started: true as const });
    }

    try {
      const team = await verifyTeamAccess({
        req: c.req.raw,
        teamSlugOrId,
      });

      const client = new MorphCloudClient({ apiKey: env.MORPH_API_KEY });
      const instance = await client.instances
        .get({ instanceId: id })
        .catch((error) => {
          console.error("[sandboxes.run-scripts] Failed to load instance", error);
          return null;
        });

      if (!instance) {
        return c.text("Sandbox not found", 404);
      }

      const metadataTeamId = (
        instance as unknown as {
          metadata?: { teamId?: string };
        }
      ).metadata?.teamId;

      if (metadataTeamId && metadataTeamId !== team.uuid) {
        return c.text("Forbidden", 403);
      }

      // Allocate script identifiers for tracking
      const scriptIdentifiers = allocateScriptIdentifiers();

      // Run scripts in background (don't await)
      (async () => {
        await runMaintenanceAndDevScripts({
          instance,
          maintenanceScript: maintenanceScript || undefined,
          devScript: devScript || undefined,
          identifiers: scriptIdentifiers,
          convexUrl: env.NEXT_PUBLIC_CONVEX_URL,
          isCloudWorkspace: true,
        });
      })().catch((error) => {
        console.error(
          "[sandboxes.run-scripts] Background script execution failed:",
          error,
        );
      });

      return c.json({ started: true as const });
    } catch (error) {
      console.error(
        "[sandboxes.run-scripts] Failed to run scripts",
        error,
      );
      return c.text("Failed to run scripts", 500);
    }
  },
);

// Stop/pause a sandbox
sandboxesRouter.openapi(
  createRoute({
    method: "post" as const,
    path: "/sandboxes/{id}/stop",
    tags: ["Sandboxes"],
    summary: "Stop or pause a sandbox instance",
    request: {
      params: z.object({ id: z.string() }),
    },
    responses: {
      204: { description: "Sandbox stopped" },
      401: { description: "Unauthorized" },
      404: { description: "Not found" },
      500: { description: "Failed to stop sandbox" },
    },
  }),
  async (c) => {
    const id = c.req.valid("param").id;
    const token = await getAccessTokenFromRequest(c.req.raw);
    if (!token) return c.text("Unauthorized", 401);

    try {
      const client = new MorphCloudClient({ apiKey: env.MORPH_API_KEY });
      const instance = await client.instances.get({ instanceId: id });
      // Kill all dev servers and user processes before pausing to avoid port conflicts on resume
      await instance.exec(VM_CLEANUP_COMMANDS);
      await instance.pause();
      return c.body(null, 204);
    } catch (error) {
      console.error("Failed to stop sandbox:", error);
      return c.text("Failed to stop sandbox", 500);
    }
  },
);

// Query status of sandbox
sandboxesRouter.openapi(
  createRoute({
    method: "get" as const,
    path: "/sandboxes/{id}/status",
    tags: ["Sandboxes"],
    summary: "Get sandbox status and URLs",
    request: {
      params: z.object({ id: z.string() }),
    },
    responses: {
      200: {
        content: {
          "application/json": {
            schema: z.object({
              running: z.boolean(),
              vscodeUrl: z.string().optional(),
              workerUrl: z.string().optional(),
              provider: z.enum(["morph"]).optional(),
            }),
          },
        },
        description: "Sandbox status",
      },
      401: { description: "Unauthorized" },
      500: { description: "Failed to get status" },
    },
  }),
  async (c) => {
    const id = c.req.valid("param").id;
    const token = await getAccessTokenFromRequest(c.req.raw);
    if (!token) return c.text("Unauthorized", 401);
    try {
      const client = new MorphCloudClient({ apiKey: env.MORPH_API_KEY });
      const instance = await client.instances.get({ instanceId: id });
      const vscodeService = instance.networking.httpServices.find(
        (s) => s.port === 39378,
      );
      const workerService = instance.networking.httpServices.find(
        (s) => s.port === 39377,
      );
      const running = Boolean(vscodeService);
      return c.json({
        running,
        vscodeUrl: vscodeService?.url,
        workerUrl: workerService?.url,
        provider: "morph",
      });
    } catch (error) {
      console.error("Failed to get sandbox status:", error);
      return c.text("Failed to get status", 500);
    }
  },
);

// Publish devcontainer forwarded ports (read devcontainer.json inside instance, expose, persist to Convex)
sandboxesRouter.openapi(
  createRoute({
    method: "post" as const,
    path: "/sandboxes/{id}/publish-devcontainer",
    tags: ["Sandboxes"],
    summary:
      "Expose forwarded ports from devcontainer.json and persist networking info",
    request: {
      params: z.object({ id: z.string() }),
      body: {
        content: {
          "application/json": {
            schema: z.object({
              teamSlugOrId: z.string(),
              taskRunId: z.string(),
            }),
          },
        },
        required: true,
      },
    },
    responses: {
      200: {
        content: {
          "application/json": {
            schema: z.array(
              z.object({
                status: z.enum(["running"]).default("running"),
                port: z.number(),
                url: z.string(),
              }),
            ),
          },
        },
        description: "Exposed ports list",
      },
      401: { description: "Unauthorized" },
      500: { description: "Failed to publish devcontainer networking" },
    },
  }),
  async (c) => {
    const token = await getAccessTokenFromRequest(c.req.raw);
    if (!token) return c.text("Unauthorized", 401);
    const { id } = c.req.valid("param");
    const { teamSlugOrId, taskRunId } = c.req.valid("json");
    try {
      const client = new MorphCloudClient({ apiKey: env.MORPH_API_KEY });
      const instance = await client.instances.get({ instanceId: id });

      const reservedPorts = RESERVED_CMUX_PORT_SET;

      // Attempt to read devcontainer.json for declared forwarded ports
      const devcontainerJson = await instance.exec(
        "cat /root/workspace/.devcontainer/devcontainer.json",
      );
      const parsed =
        devcontainerJson.exit_code === 0
          ? (JSON.parse(devcontainerJson.stdout || "{}") as {
            forwardPorts?: number[];
          })
          : { forwardPorts: [] as number[] };

      const devcontainerPorts = Array.isArray(parsed.forwardPorts)
        ? (parsed.forwardPorts as number[])
        : [];

      // Read environmentId from instance metadata (set during start)
      const instanceMeta = (
        instance as unknown as {
          metadata?: { environmentId?: string };
        }
      ).metadata;

      // Resolve environment-exposed ports (preferred)
      const db = getDb();
      let environmentPorts: number[] | undefined;
      if (instanceMeta?.environmentId) {
        try {
          const envDoc = getEnvironmentByTeam(
            db,
            teamSlugOrId,
            instanceMeta.environmentId,
          );
          environmentPorts = (envDoc?.exposedPorts as number[] | null) ?? undefined;
        } catch {
          // ignore lookup errors; fall back to devcontainer ports
        }
      }

      // Build the set of ports we want to expose and persist
      const allowedPorts = new Set<number>();
      const addAllowed = (p: number) => {
        if (!Number.isFinite(p)) return;
        const pn = Math.floor(p);
        if (pn > 0 && !reservedPorts.has(pn)) allowedPorts.add(pn);
      };

      // Prefer environment.exposedPorts if available; otherwise use devcontainer forwardPorts
      (environmentPorts && environmentPorts.length > 0
        ? environmentPorts
        : devcontainerPorts
      ).forEach(addAllowed);

      const desiredPorts = Array.from(allowedPorts.values()).sort(
        (a, b) => a - b,
      );
      const serviceNameForPort = (port: number) => `port-${port}`;

      let workingInstance = instance;
      const reloadInstance = async () => {
        workingInstance = await client.instances.get({
          instanceId: instance.id,
        });
      };

      await reloadInstance();

      for (const service of workingInstance.networking.httpServices) {
        if (!service.name.startsWith("port-")) {
          continue;
        }
        if (reservedPorts.has(service.port)) {
          continue;
        }
        if (!allowedPorts.has(service.port)) {
          await workingInstance.hideHttpService(service.name);
        }
      }

      await reloadInstance();

      for (const port of desiredPorts) {
        const serviceName = serviceNameForPort(port);
        const alreadyExposed = workingInstance.networking.httpServices.some(
          (service) => service.name === serviceName,
        );
        if (alreadyExposed) {
          continue;
        }
        try {
          await workingInstance.exposeHttpService(serviceName, port);
        } catch (error) {
          console.error(
            `[sandboxes.publishNetworking] Failed to expose ${serviceName}`,
            error,
          );
        }
      }

      await reloadInstance();

      const networking = workingInstance.networking.httpServices
        .filter((s) => allowedPorts.has(s.port))
        .map((s) => ({ status: "running" as const, port: s.port, url: s.url }));

      // Persist to DB
      updateTaskRunNetworking(db, taskRunId, networking);

      return c.json(networking);
    } catch (error) {
      console.error("Failed to publish devcontainer networking:", error);
      return c.text("Failed to publish devcontainer networking", 500);
    }
  },
);

// SSH connection info response schema
const SandboxSshResponse = z
  .object({
    morphInstanceId: z.string(),
    sshCommand: z.string().describe("Full SSH command to connect to this sandbox"),
    accessToken: z.string().describe("SSH access token for this sandbox"),
    user: z.string(),
    status: z.enum(["running", "paused"]).describe("Current instance status"),
  })
  .openapi("SandboxSshResponse");

// Get SSH connection details for a sandbox
sandboxesRouter.openapi(
  createRoute({
    method: "get" as const,
    path: "/sandboxes/{id}/ssh",
    tags: ["Sandboxes"],
    summary: "Get SSH connection details for a sandbox",
    description:
      "Returns SSH connection info for a sandbox. Use the returned sshCommand or accessToken to connect.",
    request: {
      params: z.object({ id: z.string() }),
      query: z.object({
        teamSlugOrId: z.string().optional(),
      }),
    },
    responses: {
      200: {
        content: {
          "application/json": {
            schema: SandboxSshResponse,
          },
        },
        description: "SSH connection details",
      },
      401: { description: "Unauthorized" },
      403: { description: "Forbidden - not a team member" },
      404: { description: "Sandbox not found" },
      500: { description: "Failed to get SSH info" },
    },
  }),
  async (c) => {
    const user = await getUserFromRequest(c.req.raw);
    if (!user) {
      return c.text("Unauthorized", 401);
    }

    const { id } = c.req.valid("param");
    const { teamSlugOrId } = c.req.valid("query");
    const db = getDb();

    try {
      let morphInstanceId: string | null = null;

      // Check if the id is a Morph instance ID (starts with "morphvm_")
      if (id.startsWith("morphvm_")) {
        // Direct Morph instance ID - verify ownership via instance metadata
        const morphClient = new MorphCloudClient({ apiKey: env.MORPH_API_KEY });

        // First try to find in task runs if team is provided
        if (teamSlugOrId) {
          let taskRun = null;
          try {
            taskRun = getTaskRunByContainerName(db, id);
          } catch (dbError) {
            console.log(
              `[sandboxes.ssh] DB query failed for ${id}:`,
              dbError,
            );
          }

          if (taskRun) {
            // Found in task runs - verify team access and that it's a Morph instance
            await verifyTeamAccess({
              req: c.req.raw,
              teamSlugOrId,
            });
            const vscode = taskRun.vscode as Record<string, unknown> | null;
            if (vscode?.provider !== "morph") {
              return c.text("Sandbox type not supported for SSH", 404);
            }
            morphInstanceId = id;
          }
        }

        // If not found via task run, verify ownership via instance metadata
        if (!morphInstanceId) {
          const result = await verifyInstanceOwnership(
            morphClient,
            id,
            user.id,
            async () => {
              const memberships = listTeamMemberships(db, user.id);
              return memberships.map((m) => ({ teamId: m.teams.teamId }));
            }
          );
          if (!result.authorized) {
            return c.text(result.message, result.status);
          }
          morphInstanceId = result.instanceId;
        }
      } else {
        // For task-run IDs, team is required to look up the task run
        if (!teamSlugOrId) {
          return c.text("teamSlugOrId is required for task-run IDs", 400);
        }

        // Verify team access
        const team = await verifyTeamAccess({
          req: c.req.raw,
          teamSlugOrId,
        });
        // Assume it's a task-run ID - look up the sandbox
        let taskRun: Record<string, unknown> | null = null;

        try {
          const run = getTaskRunById(db, id);
          if (run && run.teamId === team.uuid) {
            taskRun = run as unknown as Record<string, unknown>;
          }
        } catch {
          // Not a valid task run ID
          return c.text("Invalid sandbox or task-run ID", 404);
        }

        if (!taskRun) {
          return c.text("Task run not found", 404);
        }

        // Verify the task run is in the correct team
        if (taskRun.teamId !== team.uuid) {
          return c.text("Forbidden", 403);
        }

        // Check if this task run has an active Morph sandbox
        const vscodeField = taskRun.vscode as Record<string, unknown> | null;
        if (!vscodeField) {
          return c.text("No sandbox associated with this task run", 404);
        }

        if (vscodeField.provider !== "morph") {
          return c.text("Sandbox type not supported for SSH", 404);
        }

        if (!vscodeField.containerName) {
          return c.text("Sandbox container name not found", 404);
        }

        // Only return SSH info for running/starting sandboxes
        if (
          vscodeField.status !== "running" &&
          vscodeField.status !== "starting"
        ) {
          return c.text("Sandbox is not running", 404);
        }

        morphInstanceId = vscodeField.containerName as string;
      }

      if (!morphInstanceId) {
        return c.text("Could not resolve sandbox instance", 404);
      }

      // Get SSH access token from Morph API
      const sshKeyResponse = await fetch(
        `https://cloud.morph.so/api/instance/${morphInstanceId}/ssh/key`,
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${env.MORPH_API_KEY}`,
            "Content-Type": "application/json",
          },
        }
      );

      if (!sshKeyResponse.ok) {
        const errorText = await sshKeyResponse.text();
        console.error(
          `[sandboxes.ssh] Morph API returned ${sshKeyResponse.status}: ${errorText}`
        );
        // Return 404 if the instance doesn't exist in Morph
        if (sshKeyResponse.status === 404 || errorText.includes("not found")) {
          return c.text("Sandbox not found", 404);
        }
        return c.text("Failed to get SSH credentials", 500);
      }

      const sshKeyData = (await sshKeyResponse.json()) as {
        private_key: string;
        public_key: string;
        password: string;
        access_token: string;
      };

      if (!sshKeyData.access_token) {
        console.error("[sandboxes.ssh] Morph API did not return access_token");
        return c.text("Failed to get SSH credentials", 500);
      }

      // Get instance status from Morph
      const morphClient = new MorphCloudClient({ apiKey: env.MORPH_API_KEY });
      const instance = await morphClient.instances.get({ instanceId: morphInstanceId });
      const status = instance.status === "paused" ? "paused" : "running";

      const sshCommand = `ssh ${sshKeyData.access_token}@ssh.cloud.morph.so`;
      return c.json({
        morphInstanceId,
        sshCommand,
        accessToken: sshKeyData.access_token,
        user: "root",
        status,
      });
    } catch (error) {
      if (error instanceof HTTPException) {
        return c.text(error.message || "Request failed", error.status);
      }
      console.error("[sandboxes.ssh] Failed to get SSH info:", error);
      return c.text("Failed to get SSH info", 500);
    }
  },
);

// Resume a paused sandbox
const SandboxResumeResponse = z
  .object({
    resumed: z.literal(true),
  })
  .openapi("SandboxResumeResponse");

sandboxesRouter.openapi(
  createRoute({
    method: "post" as const,
    path: "/sandboxes/{id}/resume",
    tags: ["Sandboxes"],
    summary: "Resume a paused sandbox",
    description: "Resumes a paused sandbox so it can accept SSH connections.",
    request: {
      params: z.object({ id: z.string() }),
      query: z.object({
        teamSlugOrId: z.string().optional(),
      }),
    },
    responses: {
      200: {
        content: {
          "application/json": {
            schema: SandboxResumeResponse,
          },
        },
        description: "Sandbox resumed successfully",
      },
      401: { description: "Unauthorized" },
      403: { description: "Forbidden - not a team member" },
      404: { description: "Sandbox not found" },
      500: { description: "Failed to resume sandbox" },
    },
  }),
  async (c) => {
    const user = await getUserFromRequest(c.req.raw);
    if (!user) {
      return c.text("Unauthorized", 401);
    }

    const { id } = c.req.valid("param");
    const { teamSlugOrId } = c.req.valid("query");
    const db = getDb();

    try {
      let morphInstanceId: string | null = null;

      // Check if the id is a direct VM ID
      if (id.startsWith("morphvm_")) {
        // Direct Morph instance ID - verify ownership via instance metadata
        const morphClient = new MorphCloudClient({ apiKey: env.MORPH_API_KEY });

        // First try to find in task runs if team is provided
        if (teamSlugOrId) {
          let taskRun = null;
          try {
            taskRun = getTaskRunByContainerName(db, id);
          } catch (dbError) {
            console.log(
              `[sandboxes.resume] DB query failed for ${id}:`,
              dbError,
            );
          }

          if (taskRun) {
            // Found in task runs - verify team access
            await verifyTeamAccess({
              req: c.req.raw,
              teamSlugOrId,
            });
            morphInstanceId = id;
          }
        }

        // If not found via task run, verify ownership via instance metadata
        if (!morphInstanceId) {
          const result = await verifyInstanceOwnership(
            morphClient,
            id,
            user.id,
            async () => {
              const memberships = listTeamMemberships(db, user.id);
              return memberships.map((m) => ({ teamId: m.teams.teamId }));
            }
          );
          if (!result.authorized) {
            return c.text(result.message, result.status);
          }
          morphInstanceId = result.instanceId;
        }
      } else {
        // Task-run ID - team is required
        if (!teamSlugOrId) {
          return c.text("teamSlugOrId is required for task-run IDs", 400);
        }

        await verifyTeamAccess({
          req: c.req.raw,
          teamSlugOrId,
        });

        const taskRun = getTaskRunById(db, id);
        const vscode = taskRun?.vscode as Record<string, unknown> | null;

        if (!taskRun || !vscode?.containerName) {
          return c.text("Sandbox not found", 404);
        }

        if (vscode.provider !== "morph") {
          return c.text("Sandbox type not supported", 404);
        }

        morphInstanceId = vscode.containerName as string;
      }

      if (!morphInstanceId) {
        return c.text("Could not resolve sandbox instance", 404);
      }

      // Resume the instance using Morph API
      const morphClient = new MorphCloudClient({ apiKey: env.MORPH_API_KEY });
      const instance = await morphClient.instances.get({ instanceId: morphInstanceId });

      if (instance.status !== "paused") {
        // Already running, just return success
        return c.json({ resumed: true });
      }

      await instance.resume();

      // Record the resume for activity tracking (used by cleanup cron)
      // Get teamSlugOrId from request or fall back to instance metadata
      const instanceMetadata = instance.metadata as Record<string, unknown> | undefined;
      const effectiveTeamSlugOrId = teamSlugOrId ?? (instanceMetadata?.teamId as string | undefined);
      if (effectiveTeamSlugOrId && morphInstanceId) {
        try {
          recordResume(db, {
            instanceId: morphInstanceId,
            teamSlugOrId: effectiveTeamSlugOrId,
          });
        } catch (recordError) {
          // Don't fail the resume if recording fails
          console.error("[sandboxes.resume] Failed to record resume activity:", recordError);
        }
      }

      return c.json({ resumed: true });
    } catch (error) {
      if (error instanceof HTTPException) {
        return c.text(error.message || "Request failed", error.status);
      }
      console.error("[sandboxes.resume] Failed to resume sandbox:", error);
      return c.text("Failed to resume sandbox", 500);
    }
  },
);

// ── Incus Snapshot Management ────────────────────────────────────────

// Snapshot a running Incus container
sandboxesRouter.openapi(
  createRoute({
    method: "post" as const,
    path: "/sandboxes/{id}/snapshot",
    tags: ["Sandboxes"],
    summary: "Create a snapshot of a running Incus container",
    request: {
      params: z.object({ id: z.string() }),
      body: {
        content: {
          "application/json": {
            schema: z.object({
              snapshotId: z.string(),
            }),
          },
        },
        required: true,
      },
    },
    responses: {
      200: {
        content: {
          "application/json": {
            schema: z.object({
              snapshotId: z.string(),
              created: z.literal(true),
            }),
          },
        },
        description: "Snapshot created",
      },
      401: { description: "Unauthorized" },
      404: { description: "Container not found" },
      500: { description: "Failed to create snapshot" },
    },
  }),
  async (c) => {
    const token = await getAccessTokenFromRequest(c.req.raw);
    if (!token) return c.text("Unauthorized", 401);

    const { id } = c.req.valid("param");
    const { snapshotId } = c.req.valid("json");

    try {
      let instance = incusVmRegistry.get(id);
      if (!instance) {
        // Registry lost — find a provider to route to
        const db = getDb();
        const providerId = resolveIncusProviderId(db, "default");
        if (!providerId) return c.text("No Incus provider available", 502);
        instance = new RemoteIncusSandboxInstance({ id, providerId });
      }

      await instance.snapshot(snapshotId);
      return c.json({ snapshotId, created: true as const });
    } catch (error) {
      console.error("[sandboxes.snapshot] Failed to create snapshot:", error);
      return c.text("Failed to create snapshot", 500);
    }
  },
);

// List Incus snapshots
sandboxesRouter.openapi(
  createRoute({
    method: "get" as const,
    path: "/sandboxes/incus/snapshots",
    tags: ["Sandboxes"],
    summary: "List available Incus snapshots",
    responses: {
      200: {
        content: {
          "application/json": {
            schema: z.object({
              snapshots: z.array(z.string()),
            }),
          },
        },
        description: "List of snapshot IDs",
      },
      401: { description: "Unauthorized" },
    },
  }),
  async (c) => {
    const token = await getAccessTokenFromRequest(c.req.raw);
    if (!token) return c.text("Unauthorized", 401);

    // List snapshots from the first online Incus provider
    const db = getDb();
    const providerId = resolveIncusProviderId(db, "default");
    if (!providerId) return c.json({ snapshots: [] });

    const snapshots = await listProviderSnapshots(providerId);
    return c.json({ snapshots });
  },
);

// Delete an Incus snapshot
sandboxesRouter.openapi(
  createRoute({
    method: "delete" as const,
    path: "/sandboxes/incus/snapshots/{snapshotId}",
    tags: ["Sandboxes"],
    summary: "Delete an Incus snapshot",
    request: {
      params: z.object({ snapshotId: z.string() }),
    },
    responses: {
      200: {
        content: {
          "application/json": {
            schema: z.object({
              deleted: z.literal(true),
            }),
          },
        },
        description: "Snapshot deleted",
      },
      401: { description: "Unauthorized" },
      404: { description: "Snapshot not found" },
      500: { description: "Failed to delete snapshot" },
    },
  }),
  async (c) => {
    const token = await getAccessTokenFromRequest(c.req.raw);
    if (!token) return c.text("Unauthorized", 401);

    const { snapshotId } = c.req.valid("param");

    try {
      const db = getDb();
      const providerId = resolveIncusProviderId(db, "default");
      if (!providerId) return c.text("No Incus provider available", 502);
      await deleteProviderSnapshot(providerId, snapshotId);
      return c.json({ deleted: true as const });
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes("Snapshot not found")
      ) {
        return c.text("Snapshot not found", 404);
      }
      console.error("[sandboxes.snapshot] Failed to delete snapshot:", error);
      return c.text("Failed to delete snapshot", 500);
    }
  },
);

// ── Incus Pause/Resume/Status/Destroy ────────────────────────────────

// Pause a running Incus container
sandboxesRouter.openapi(
  createRoute({
    method: "post" as const,
    path: "/sandboxes/incus/{id}/pause",
    tags: ["Sandboxes"],
    summary: "Pause a running Incus container",
    request: {
      params: z.object({ id: z.string() }),
    },
    responses: {
      200: {
        content: {
          "application/json": {
            schema: z.object({ paused: z.literal(true) }),
          },
        },
        description: "Container paused",
      },
      401: { description: "Unauthorized" },
      404: { description: "Container not found" },
      500: { description: "Failed to pause container" },
    },
  }),
  async (c) => {
    const token = await getAccessTokenFromRequest(c.req.raw);
    if (!token) return c.text("Unauthorized", 401);

    const { id } = c.req.valid("param");
    let instance = incusVmRegistry.get(id);
    if (!instance) {
      const db = getDb();
      const providerId = resolveIncusProviderId(db, "default");
      if (!providerId) return c.text("No Incus provider available", 502);
      instance = new RemoteIncusSandboxInstance({ id, providerId });
    }

    try {
      await instance.pause();
      return c.json({ paused: true as const });
    } catch (error) {
      console.error("[sandboxes.incus] Failed to pause container:", error);
      return c.text("Failed to pause container", 500);
    }
  },
);

// Resume a paused Incus container
sandboxesRouter.openapi(
  createRoute({
    method: "post" as const,
    path: "/sandboxes/incus/{id}/resume",
    tags: ["Sandboxes"],
    summary: "Resume a paused Incus container",
    request: {
      params: z.object({ id: z.string() }),
    },
    responses: {
      200: {
        content: {
          "application/json": {
            schema: z.object({ resumed: z.literal(true) }),
          },
        },
        description: "Container resumed",
      },
      401: { description: "Unauthorized" },
      404: { description: "Container not found" },
      500: { description: "Failed to resume container" },
    },
  }),
  async (c) => {
    const token = await getAccessTokenFromRequest(c.req.raw);
    if (!token) return c.text("Unauthorized", 401);

    const { id } = c.req.valid("param");
    let instance = incusVmRegistry.get(id);
    if (!instance) {
      const db = getDb();
      const providerId = resolveIncusProviderId(db, "default");
      if (!providerId) return c.text("No Incus provider available", 502);
      instance = new RemoteIncusSandboxInstance({ id, providerId });
    }

    try {
      await instance.resume();
      return c.json({ resumed: true as const });
    } catch (error) {
      console.error("[sandboxes.incus] Failed to resume container:", error);
      return c.text("Failed to resume container", 500);
    }
  },
);

// Get Incus container status
sandboxesRouter.openapi(
  createRoute({
    method: "get" as const,
    path: "/sandboxes/incus/{id}/status",
    tags: ["Sandboxes"],
    summary: "Get Incus container status",
    request: {
      params: z.object({ id: z.string() }),
    },
    responses: {
      200: {
        content: {
          "application/json": {
            schema: z.object({
              running: z.boolean(),
              paused: z.boolean(),
            }),
          },
        },
        description: "Container status",
      },
      401: { description: "Unauthorized" },
      404: { description: "Container not found" },
    },
  }),
  async (c) => {
    const token = await getAccessTokenFromRequest(c.req.raw);
    if (!token) return c.text("Unauthorized", 401);

    const { id } = c.req.valid("param");
    const instance = incusVmRegistry.get(id);
    if (instance) {
      return c.json({ running: true, paused: instance.isPaused });
    }

    // Registry lost — query provider daemon for status
    try {
      const db = getDb();
      const providerId = resolveIncusProviderId(db, "default");
      if (providerId) {
        const data = await sendProviderRequest(providerId, "compute.getStatus", { id }) as {
          status: string;
          paused: boolean;
        };
        return c.json({ running: data.status === "running", paused: data.paused });
      }
    } catch {
      // Provider unavailable
    }
    return c.json({ running: false, paused: false });
  },
);

// Destroy an Incus container
sandboxesRouter.openapi(
  createRoute({
    method: "post" as const,
    path: "/sandboxes/incus/{id}/destroy",
    tags: ["Sandboxes"],
    summary: "Destroy an Incus container",
    request: {
      params: z.object({ id: z.string() }),
    },
    responses: {
      200: {
        content: {
          "application/json": {
            schema: z.object({ destroyed: z.literal(true) }),
          },
        },
        description: "Container destroyed",
      },
      401: { description: "Unauthorized" },
      404: { description: "Container not found" },
      500: { description: "Failed to destroy container" },
    },
  }),
  async (c) => {
    const token = await getAccessTokenFromRequest(c.req.raw);
    if (!token) return c.text("Unauthorized", 401);

    const { id } = c.req.valid("param");
    try {
      const instance = incusVmRegistry.get(id);
      if (instance) {
        await instance.destroy();
        incusVmRegistry.delete(id);
      } else {
        // Registry lost (server restart / HMR) — delete via provider daemon
        const db = getDb();
        const providerId = resolveIncusProviderId(db, "default");
        if (!providerId) return c.text("No Incus provider available", 502);
        const remoteInstance = new RemoteIncusSandboxInstance({ id, providerId });
        await remoteInstance.destroy();
      }
      return c.json({ destroyed: true as const });
    } catch (error) {
      console.error("[sandboxes.incus] Failed to destroy container:", error);
      return c.text("Failed to destroy container", 500);
    }
  },
);

// ── Incus Task-Run-Level Pause/Resume ────────────────────────────────

// Check if a task run's Incus container is paused
sandboxesRouter.openapi(
  createRoute({
    method: "post" as const,
    path: "/sandboxes/incus/task-runs/{taskRunId}/is-paused",
    tags: ["Sandboxes"],
    summary: "Check if a task run's Incus container is paused",
    request: {
      params: z.object({ taskRunId: z.string() }),
      body: {
        content: {
          "application/json": {
            schema: z.object({ teamSlugOrId: z.string() }),
          },
        },
        required: true,
      },
    },
    responses: {
      200: {
        content: {
          "application/json": {
            schema: z.object({ paused: z.boolean() }),
          },
        },
        description: "Pause status",
      },
      401: { description: "Unauthorized" },
      404: { description: "Task run not found" },
    },
  }),
  async (c) => {
    const accessToken = await getAccessTokenFromRequest(c.req.raw);
    if (!accessToken) return c.text("Unauthorized", 401);

    const { taskRunId } = c.req.valid("param");
    const { teamSlugOrId: _teamSlugOrId } = c.req.valid("json");
    const db = getDb();

    try {
      const taskRun = getTaskRunById(db, taskRunId);
      const vscode = taskRun?.vscode as Record<string, unknown> | null;

      if (!vscode?.containerName) {
        return c.text("Task run or container not found", 404);
      }

      const containerName = vscode.containerName as string;

      // Check if this is an Incus container (provider is "incus" or legacy "docker" with cmux- prefix)
      const isIncus =
        vscode.provider === "incus" ||
        (vscode.provider === "docker" && containerName.startsWith("cmux-"));

      if (!isIncus) {
        return c.json({ paused: false });
      }

      const instance = incusVmRegistry.get(containerName);
      if (instance) {
        return c.json({ paused: instance.isPaused });
      }

      // Registry lost — query provider daemon for status
      try {
        const providerId = resolveIncusProviderId(db, _teamSlugOrId, vscode);
        if (providerId) {
          const data = await sendProviderRequest(providerId, "compute.getStatus", {
            id: containerName,
          }) as { paused: boolean };
          return c.json({ paused: data.paused });
        }
      } catch {
        // Provider unavailable — fall through
      }
      return c.json({ paused: false });
    } catch (error) {
      console.error("[sandboxes.incus] Failed to check pause status:", error);
      return c.json({ paused: false });
    }
  },
);

// Resume a task run's Incus container
sandboxesRouter.openapi(
  createRoute({
    method: "post" as const,
    path: "/sandboxes/incus/task-runs/{taskRunId}/resume",
    tags: ["Sandboxes"],
    summary: "Resume a task run's Incus container",
    request: {
      params: z.object({ taskRunId: z.string() }),
      body: {
        content: {
          "application/json": {
            schema: z.object({ teamSlugOrId: z.string() }),
          },
        },
        required: true,
      },
    },
    responses: {
      200: {
        content: {
          "application/json": {
            schema: z.object({ resumed: z.literal(true) }),
          },
        },
        description: "Container resumed",
      },
      401: { description: "Unauthorized" },
      404: { description: "Task run or container not found" },
      500: { description: "Failed to resume container" },
    },
  }),
  async (c) => {
    const accessToken = await getAccessTokenFromRequest(c.req.raw);
    if (!accessToken) return c.text("Unauthorized", 401);

    const { taskRunId } = c.req.valid("param");
    const { teamSlugOrId: _teamSlugOrId } = c.req.valid("json");
    const db = getDb();

    try {
      const taskRun = getTaskRunById(db, taskRunId);
      const vscode = taskRun?.vscode as Record<string, unknown> | null;

      if (!vscode?.containerName) {
        return c.text("Task run or container not found", 404);
      }

      const containerName = vscode.containerName as string;

      const isIncus =
        vscode.provider === "incus" ||
        (vscode.provider === "docker" && containerName.startsWith("cmux-"));

      if (!isIncus) {
        return c.text("Not an Incus container", 404);
      }

      let instance = incusVmRegistry.get(containerName);
      if (!instance) {
        // Registry lost — find provider to route to
        const providerId = resolveIncusProviderId(db, _teamSlugOrId, vscode);
        if (!providerId) return c.text("No Incus provider available", 502);
        instance = new RemoteIncusSandboxInstance({ id: containerName, providerId });
      }

      await instance.resume();
      return c.json({ resumed: true as const });
    } catch (error) {
      console.error("[sandboxes.incus] Failed to resume container:", error);
      return c.text("Failed to resume container", 500);
    }
  },
);
