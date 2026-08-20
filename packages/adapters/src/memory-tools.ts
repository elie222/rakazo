import type { ConnectorTool } from "@rakazo/adapter-kit";

const SUPERMEMORY_TOOL_NAMES = new Set(["recall_memory", "save_memory"]);

export function selectMemoryTools(
  tools: ConnectorTool[],
  supermemoryConfigured: boolean,
): ConnectorTool[] {
  return supermemoryConfigured
    ? tools.filter((tool) => tool.name !== "remember")
    : tools.filter((tool) => !SUPERMEMORY_TOOL_NAMES.has(tool.name));
}
