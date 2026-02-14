import { stackServerAppJs } from "@/lib/utils/stack";
import { env } from "@/lib/utils/www-env";

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
