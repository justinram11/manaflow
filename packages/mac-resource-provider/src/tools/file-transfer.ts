import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import type { ToolDefinition, ToolHandler } from "./index";
import { getAllocation } from "../workspace-manager";
import { copyFileFromVm, fileExistsInVm } from "../tart-vm";

const iosPullFile: ToolHandler = async (params, allocationId) => {
  const alloc = getAllocation(allocationId);
  if (!alloc) throw new Error("Allocation not found");

  const remotePath = params.remote_path as string;
  if (!remotePath) {
    return { error: "remote_path is required" };
  }

  const localFilename = (params.local_filename as string) || basename(remotePath);

  // Verify the file exists on the VM before attempting to copy
  if (!fileExistsInVm(alloc.tartVmName, remotePath)) {
    return { error: `File not found on VM: ${remotePath}` };
  }

  const tmpDir = mkdtempSync(join(tmpdir(), "cmux-pull-"));
  const localPath = join(tmpDir, localFilename);

  try {
    copyFileFromVm(alloc.tartVmName, remotePath, localPath);
    return { success: true, localPath };
  } catch (error) {
    console.error("[ios_pull_file] scp failed:", error);
    return { error: String(error) };
  }
};

export const fileTransferTools: Array<{ definition: ToolDefinition; handler: ToolHandler }> = [
  {
    definition: {
      name: "ios_pull_file",
      description:
        "Copy a file from the Tart VM to the local host. Returns the local file path so you can read or inspect the file.",
      inputSchema: {
        type: "object",
        properties: {
          remote_path: {
            type: "string",
            description: "Absolute path of the file on the VM to copy",
          },
          local_filename: {
            type: "string",
            description: "Optional filename to save as locally (defaults to the remote filename)",
          },
        },
        required: ["remote_path"],
      },
    },
    handler: iosPullFile,
  },
];
