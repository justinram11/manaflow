import type { SandboxInstance } from "./sandbox-instance";

/**
 * Inject AWS credentials and config files into a sandbox instance.
 * Writes ~/.aws/credentials and ~/.aws/config so that AWS CLI / SDKs
 * inside sandboxes can authenticate without manual setup.
 *
 * Follows the same base64 + instance.exec() pattern as claude-credentials.ts.
 */
export async function injectAwsCredentials(
  instance: SandboxInstance,
  apiKeys: Record<string, string>,
): Promise<void> {
  const credentialsContent = apiKeys.AWS_CREDENTIALS_FILE?.trim();
  const configContent = apiKeys.AWS_CONFIG_FILE?.trim();

  if (!credentialsContent && !configContent) {
    return;
  }

  await instance.exec("mkdir -p /root/.aws && chmod 700 /root/.aws");

  const promises: Promise<void>[] = [];

  if (credentialsContent) {
    const b64 = Buffer.from(credentialsContent).toString("base64");
    promises.push(
      instance
        .exec(
          `echo '${b64}' | base64 -d > /root/.aws/credentials && chmod 600 /root/.aws/credentials`,
        )
        .then((res) => {
          if (res.exit_code !== 0) {
            console.error(
              `[aws-credentials] Failed to write credentials: ${res.stderr}`,
            );
          }
        }),
    );
  }

  if (configContent) {
    const b64 = Buffer.from(configContent).toString("base64");
    promises.push(
      instance
        .exec(
          `echo '${b64}' | base64 -d > /root/.aws/config && chmod 600 /root/.aws/config`,
        )
        .then((res) => {
          if (res.exit_code !== 0) {
            console.error(
              `[aws-credentials] Failed to write config: ${res.stderr}`,
            );
          }
        }),
    );
  }

  await Promise.all(promises);
  console.log(
    `[aws-credentials] Injected AWS ${credentialsContent ? "credentials" : ""}${credentialsContent && configContent ? " and " : ""}${configContent ? "config" : ""} into sandbox`,
  );
}
