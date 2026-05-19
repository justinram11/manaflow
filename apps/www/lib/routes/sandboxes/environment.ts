import { Buffer } from "node:buffer";
import { stackServerAppJs } from "@/lib/utils/stack";
import { env } from "@/lib/utils/www-env";
import type { SandboxInstance } from "./sandbox-instance";

export const loadEnvironmentEnvVars = async (
  dataVaultKey: string
): Promise<string | null> => {
  try {
    const store =
      await stackServerAppJs.getDataVaultStore("cmux-snapshot-envs");
    const content = await store.getValue(dataVaultKey, {
      secret: env.STACK_DATA_VAULT_SECRET ?? "",
    });
    const length = content?.length ?? 0;
    console.log(
      `[sandboxes.start] Loaded environment env vars (chars=${length})`
    );
    return content;
  } catch (error) {
    console.error(
      "[sandboxes.start] Failed to fetch environment env vars",
      error
    );
    return null;
  }
};

// Stored alongside the env-vars value in DataVault under a derived suffix
// key. This avoids a DB migration: the same dataVaultKey on the
// environment/workspaceConfig row addresses both the process env vars and
// the workspace .env file.
const envFileVaultKey = (dataVaultKey: string): string =>
  `${dataVaultKey}:envFile`;

export const loadEnvironmentEnvFile = async (
  dataVaultKey: string
): Promise<string | null> => {
  try {
    const store =
      await stackServerAppJs.getDataVaultStore("cmux-snapshot-envs");
    const content = await store.getValue(envFileVaultKey(dataVaultKey), {
      secret: env.STACK_DATA_VAULT_SECRET ?? "",
    });
    return content;
  } catch (error) {
    console.error(
      "[sandboxes.start] Failed to fetch environment env file",
      error
    );
    return null;
  }
};

export const saveEnvironmentEnvFile = async (
  dataVaultKey: string,
  content: string
): Promise<void> => {
  const store = await stackServerAppJs.getDataVaultStore("cmux-snapshot-envs");
  await store.setValue(envFileVaultKey(dataVaultKey), content, {
    secret: env.STACK_DATA_VAULT_SECRET ?? "",
  });
};

/**
 * Write the user-provided .env file to the workspace root inside a sandbox.
 *
 * Called after hydration (git clone) so the file isn't clobbered, and
 * before the maintenance/dev scripts so they can read it. Mode 600 because
 * the file may contain secrets.
 */
export const writeWorkspaceEnvFile = async (
  instance: SandboxInstance,
  content: string,
  workspaceDir = "/root/workspace"
): Promise<void> => {
  const b64 = Buffer.from(content, "utf8").toString("base64");
  const res = await instance.exec(
    `mkdir -p ${workspaceDir} && echo '${b64}' | base64 -d > ${workspaceDir}/.env && chmod 600 ${workspaceDir}/.env`
  );
  if (res.exit_code !== 0) {
    console.error(
      `[sandboxes.start] Failed to write ${workspaceDir}/.env: ${res.stderr}`
    );
  } else {
    console.log(
      `[sandboxes.start] Wrote ${workspaceDir}/.env (chars=${content.length})`
    );
  }
};
