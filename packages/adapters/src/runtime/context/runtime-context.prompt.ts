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

export const SCREENSHOT_REMOVED_NOTE = "[Older screenshot removed; observe again if needed]";

export const TOOL_IMAGE_REMOVED_NOTE = "[Older image removed; call the tool again if needed]";

export const STALE_PAGE_STATE_NOTE =
  "[Earlier page state trimmed to save context. Facts you still need from that page should already be in your notes or tracker; otherwise take a fresh snapshot.]";

/**
 * A result cut before the model read it is missing evidence. A result cut after the model read
 * it is not: saying "unavailable" there makes a model retract statements it made from it.
 */
export const OMITTED_BEFORE_USE =
  "[Tool result truncated to fit context; omitted evidence is unavailable.]";
export const OMITTED_TEXT_BEFORE_USE =
  "[Tool result truncated to fit context; inspect original evidence before claiming omitted details.]";
export const OMITTED_AFTER_USE =
  "[Earlier result shortened after you read it; statements made from it stand. Re-run the tool only if you need the omitted text.]";
