import type { ConnectorTool } from "@rakazo/adapter-kit";

const SEMANTIC_MEMORY_TOOL_NAMES = new Set(["recall_memory", "save_memory", "forget_memory"]);

export function selectMemoryTools(
  tools: ConnectorTool[],
  semanticMemoryConfigured: boolean,
): ConnectorTool[] {
  return semanticMemoryConfigured
    ? tools.filter((tool) => tool.name !== "remember")
    : tools.filter((tool) => !SEMANTIC_MEMORY_TOOL_NAMES.has(tool.name));
}

/** Adds a remembered fact to a bot memory document without dropping what it already holds. */
export function appendMemoryFact(existing: string, fact: string): string {
  const current = existing.trimEnd();
  const next = fact.trim();
  if (
    !next ||
    `\n${current}\n`.includes(`\n${next}\n`) ||
    (!next.includes("\n") && current.split("\n").some((line) => line.trim() === next))
  )
    return existing;
  return current ? `${current}\n${next}\n` : `${next}\n`;
}
