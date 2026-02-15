import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { SandboxInstance } from "./sandbox-instance";

/** SSH key files to inject (in order of preference) */
const SSH_KEY_FILES = [
  "id_ed25519",
  "id_rsa",
  "id_ecdsa",
  "config",
  "known_hosts",
];

/**
 * Inject the host's SSH keys and git config into a sandbox instance.
 * This mirrors what Docker does via bind-mounts in `getSshBindMounts()`,
 * but uses `instance.exec()` to write files since Firecracker VMs don't
 * support bind mounts.
 */
export async function injectHostSshKeys(
  instance: SandboxInstance,
): Promise<void> {
  const sshDir = path.join(os.homedir(), ".ssh");

  // Ensure ~/.ssh exists in the VM
  await instance.exec("mkdir -p /root/.ssh && chmod 700 /root/.ssh");

  const promises: Promise<void>[] = [];

  // Inject SSH key files
  if (fs.existsSync(sshDir)) {
    for (const filename of SSH_KEY_FILES) {
      const filePath = path.join(sshDir, filename);
      if (!fs.existsSync(filePath)) continue;

      try {
        const stat = fs.statSync(filePath);
        // Skip directories and overly large files (> 100KB)
        if (stat.isDirectory() || stat.size > 100_000) continue;

        const content = fs.readFileSync(filePath, "utf-8");
        // Determine correct permissions: private keys get 600, others get 644
        const isPrivateKey = filename.startsWith("id_") && !filename.endsWith(".pub");
        const perms = isPrivateKey ? "600" : "644";

        const destPath = `/root/.ssh/${filename}`;
        // Use base64 to safely transport file contents through shell
        const b64 = Buffer.from(content).toString("base64");
        promises.push(
          instance
            .exec(
              `echo '${b64}' | base64 -d > ${destPath} && chmod ${perms} ${destPath}`,
            )
            .then((res) => {
              if (res.exit_code !== 0) {
                console.error(
                  `[ssh-keys] Failed to write ${destPath}: ${res.stderr}`,
                );
              }
            }),
        );
      } catch (error) {
        console.error(`[ssh-keys] Failed to read ${filePath}:`, error);
      }
    }
  }

  // Inject ~/.gitconfig
  const gitconfigPath = path.join(os.homedir(), ".gitconfig");
  if (fs.existsSync(gitconfigPath)) {
    try {
      const content = fs.readFileSync(gitconfigPath, "utf-8");
      const b64 = Buffer.from(content).toString("base64");
      promises.push(
        instance
          .exec(
            `echo '${b64}' | base64 -d > /root/.gitconfig && chmod 644 /root/.gitconfig`,
          )
          .then((res) => {
            if (res.exit_code !== 0) {
              console.error(
                `[ssh-keys] Failed to write /root/.gitconfig: ${res.stderr}`,
              );
            }
          }),
      );
    } catch (error) {
      console.error(`[ssh-keys] Failed to read ${gitconfigPath}:`, error);
    }
  }

  await Promise.all(promises);
  console.log(
    `[ssh-keys] Injected ${promises.length} SSH/git config files into sandbox`,
  );
}
