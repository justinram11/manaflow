import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { ToolDefinition, ToolHandler } from "./index";
import { getAllocation } from "../workspace-manager";

/**
 * Default excludes ported from packages/cloudrouter/internal/cli/rsync.go
 */
const RSYNC_EXCLUDES = [
  // Version control
  ".git", ".hg", ".svn",
  // Package manager dependencies
  "node_modules", ".pnpm-store", "vendor", "target", ".gradle",
  "Pods", ".dart_tool", ".pub-cache", ".bundle", "elm-stuff",
  "bower_components", "jspm_packages",
  // Virtual environments
  ".venv", "venv", "env", "virtualenv", ".virtualenv", ".conda",
  "conda-env", ".pixi",
  // Build artifacts
  "dist", "build", "out", ".next", ".nuxt", ".output", ".svelte-kit",
  ".vercel", ".netlify", "storybook-static", "coverage", ".nyc_output",
  // Caches
  ".cache", ".turbo", ".parcel-cache", ".webpack", ".rollup.cache",
  ".eslintcache", ".stylelintcache", ".prettiercache", "__pycache__",
  ".mypy_cache", ".pytest_cache", ".ruff_cache", ".tox", ".nox",
  ".hypothesis", "*.egg-info", ".eggs",
  // Secrets and credentials
  ".npmrc", ".yarnrc", ".yarnrc.yml", "auth.json", ".netrc",
  "credentials.json", "secrets.json", "*.pem", "*.key", "*.p12",
  "*.pfx", ".aws", ".docker/config.json",
  // OS and IDE files
  ".DS_Store", "Thumbs.db", "desktop.ini", ".Spotlight-V100",
  ".Trashes", ".idea", "*.swp", "*.swo", "*~", ".project",
  ".classpath", ".settings", "*.sublime-*",
  // Logs and temp files
  "*.log", "logs", "tmp", "temp", ".temp", ".tmp",
  "npm-debug.log*", "yarn-debug.log*", "yarn-error.log*",
  "pnpm-debug.log*", "lerna-debug.log*",
  // Compiled files
  "*.pyc", "*.pyo", "*.o", "*.obj", "*.so", "*.dylib", "*.dll", "*.class",
  // Large generated files
  "*.js.map", "*.css.map",
];

const iosSyncCode: ToolHandler = async (_params, allocationId) => {
  const alloc = getAllocation(allocationId);
  if (!alloc) throw new Error("Allocation not found");

  if (!alloc.rsyncEndpoint || !alloc.rsyncSecret) {
    return { error: "rsync not configured for this allocation. The container may not have started rsyncd yet." };
  }

  mkdirSync(alloc.buildDir, { recursive: true });

  // Write password file for rsync (must be mode 600)
  const passwordFile = join(alloc.buildDir, ".rsync-password");
  writeFileSync(passwordFile, alloc.rsyncSecret, { mode: 0o600 });

  try {
    const excludeArgs = RSYNC_EXCLUDES.map((e) => `--exclude=${e}`).join(" ");
    const cmd = `rsync -az --delete ${excludeArgs} --password-file="${passwordFile}" "${alloc.rsyncEndpoint}" "${alloc.buildDir}/"`;

    execSync(cmd, {
      encoding: "utf-8",
      timeout: 120000,
    });

    // Count synced files
    const fileCount = execSync(`find "${alloc.buildDir}" -type f | wc -l`, {
      encoding: "utf-8",
    }).trim();

    return { success: true, buildDir: alloc.buildDir, fileCount: parseInt(fileCount, 10) };
  } catch (error) {
    console.error("[ios_sync_code] rsync failed:", error);
    return { error: String(error) };
  } finally {
    try { unlinkSync(passwordFile); } catch { /* ignore */ }
  }
};

export const syncTools: Array<{ definition: ToolDefinition; handler: ToolHandler }> = [
  {
    definition: {
      name: "ios_sync_code",
      description:
        "Sync workspace source code to the Mac build directory using rsync. No parameters needed — syncs incrementally from the container. Call this before building.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    handler: iosSyncCode,
  },
];
