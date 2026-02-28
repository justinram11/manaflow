import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { ToolDefinition, ToolHandler } from "./index";
import { getAllocation } from "../workspace-manager";

const iosSyncCode: ToolHandler = async (params, allocationId) => {
  const alloc = getAllocation(allocationId);
  if (!alloc) throw new Error("Allocation not found");

  // The tarball data comes as base64 in params (sent through WebSocket)
  const tarBase64 = params.tarball as string | undefined;

  if (!tarBase64) {
    return { error: "No tarball data provided. Send code as base64-encoded tar.gz." };
  }

  // Decode and extract
  mkdirSync(alloc.buildDir, { recursive: true });
  const tarPath = join(alloc.buildDir, ".cmux-sync.tar.gz");

  try {
    const tarData = Buffer.from(tarBase64, "base64");
    writeFileSync(tarPath, tarData);
    execSync(`tar -xzf "${tarPath}" -C "${alloc.buildDir}"`, {
      encoding: "utf-8",
      timeout: 60000,
    });
    unlinkSync(tarPath);

    // Count synced files
    const fileCount = execSync(`find "${alloc.buildDir}" -type f | wc -l`, {
      encoding: "utf-8",
    }).trim();

    return { success: true, buildDir: alloc.buildDir, fileCount: parseInt(fileCount, 10) };
  } catch (error) {
    return { error: String(error) };
  }
};

export const syncTools: Array<{ definition: ToolDefinition; handler: ToolHandler }> = [
  {
    definition: {
      name: "ios_sync_code",
      description:
        "Sync workspace source code to the Mac build directory. Receives a base64-encoded tar.gz of the project source. Call this before building.",
      inputSchema: {
        type: "object",
        properties: {
          tarball: {
            type: "string",
            description: "Base64-encoded tar.gz of the workspace source code",
          },
        },
        required: ["tarball"],
      },
    },
    handler: iosSyncCode,
  },
];
