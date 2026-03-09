import { buildTools } from "./build";
import { simulatorTools } from "./simulator";
import { interactionTools } from "./interaction";
import { logTools } from "./logs";
import { syncTools } from "./sync";
import { appStateTools } from "./app-state";
import { fileTransferTools } from "./file-transfer";

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export type ToolHandler = (
  params: Record<string, unknown>,
  allocationId: string,
) => Promise<unknown>;

interface ToolRegistry {
  definition: ToolDefinition;
  handler: ToolHandler;
}

const registry = new Map<string, ToolRegistry>();

function registerTools(tools: Array<{ definition: ToolDefinition; handler: ToolHandler }>) {
  for (const tool of tools) {
    registry.set(tool.definition.name, tool);
  }
}

// Register all tool groups
registerTools(buildTools);
registerTools(simulatorTools);
registerTools(interactionTools);
registerTools(logTools);
registerTools(syncTools);
registerTools(appStateTools);
registerTools(fileTransferTools);

export function getToolDefinitions(): ToolDefinition[] {
  return Array.from(registry.values()).map((t) => t.definition);
}

export function getTool(name: string): ToolRegistry | undefined {
  return registry.get(name);
}
