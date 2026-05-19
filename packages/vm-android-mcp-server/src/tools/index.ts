import { deviceTools } from "./device";
import { appTools } from "./app";
import { interactionTools } from "./interaction";
import { logTools } from "./logs";

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

registerTools(deviceTools);
registerTools(appTools);
registerTools(interactionTools);
registerTools(logTools);

export function getToolDefinitions(): ToolDefinition[] {
  return Array.from(registry.values()).map((t) => t.definition);
}

export function getTool(name: string): ToolRegistry | undefined {
  return registry.get(name);
}
