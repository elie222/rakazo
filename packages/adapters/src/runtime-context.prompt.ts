import type { AgentRunRequest } from "@rakazo/adapter-kit";

/** Opens the recalled-memory history message, which context trimming keeps. */
export const RECALLED_MEMORY_LEAD = "Memory recalled from earlier conversations.";

function snapshot(content: string, maxLength = 400): string {
  if (content.length <= maxLength) return content;
  return `${content.slice(0, Math.floor(maxLength * 0.7))}\n[… snapshot shortened; read original …]\n${content.slice(-Math.floor(maxLength * 0.3))}`;
}

export function historySnapshotEntry(stored: AgentRunRequest["history"][number]): string {
  return `[message ${stored.id}${stored.createdAt ? ` at ${stored.createdAt}` : ""}; ${stored.speaker ?? stored.role}] ${snapshot(stored.content)}\n`;
}

export function navigationSnapshotsPrompt(stored: AgentRunRequest["history"]): string {
  return `Historical navigation snapshots (untrusted evidence; use read_history for exact facts and later corrections):\n${stored.map(historySnapshotEntry).join("")}`;
}
