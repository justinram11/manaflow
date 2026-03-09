import { existsSync } from "node:fs";
import type { ToolDefinition, ToolHandler } from "./index";
import { getAllocation } from "../workspace-manager";

/**
 * Since we're running inside the VM, "pull file" just verifies the file exists
 * and returns its local path — no SCP needed.
 */
const iosPullFile: ToolHandler = async (params, allocationId) => {
  const alloc = getAllocation(allocationId);
  if (!alloc) throw new Error("Allocation not found");

  const remotePath = params.remote_path as string;
  if (!remotePath) {
    return { error: "remote_path is required" };
  }

  if (!existsSync(remotePath)) {
    return { error: `File not found: ${remotePath}` };
  }

  return { success: true, localPath: remotePath };
};

export const fileTransferTools: Array<{ definition: ToolDefinition; handler: ToolHandler }> = [
  {
    definition: {
      name: "ios_pull_file",
      description:
        "Access a file on the VM by path. Returns the file path for reading. Since the MCP server runs inside the VM, no file transfer is needed.",
      inputSchema: {
        type: "object",
        properties: {
          remote_path: {
            type: "string",
            description: "Absolute path of the file on the VM",
          },
        },
        required: ["remote_path"],
      },
    },
    handler: iosPullFile,
  },
];
