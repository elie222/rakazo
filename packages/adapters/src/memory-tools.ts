import type { ConnectorTool } from "@rakazo/adapter-kit";

const SEMANTIC_MEMORY_TOOL_NAMES = new Set(["recall_memory", "save_memory"]);

export function selectMemoryTools(
  tools: ConnectorTool[],
  semanticMemoryConfigured: boolean,
): ConnectorTool[] {
  return semanticMemoryConfigured
    ? tools.filter((tool) => tool.name !== "remember")
    : tools.filter((tool) => !SEMANTIC_MEMORY_TOOL_NAMES.has(tool.name));
}
