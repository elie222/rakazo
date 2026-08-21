import type { MessageBlock } from "@rakazo/contracts";
import { blocksToAgentHistoryText } from "@rakazo/core";

export const MAX_AGENT_HISTORY_BYTES = 32 * 1024;
export const MAX_AGENT_HISTORY_MESSAGE_BYTES = 4 * 1024;
export const MIN_AGENT_HISTORY_MESSAGES = 8;

const TRUNCATION_SUFFIX = "\n\n(truncated)";

export type AgentHistoryEntry = {
  role: "user" | "assistant" | "system";
  content: string;
};

export interface AgentHistoryWindowOptions {
  maxBytes?: number;
  maxMessageBytes?: number;
  minMessages?: number;
}

export function buildAgentHistoryWindow(
  messages: Array<{ role: string; blocks: unknown }>,
  options: AgentHistoryWindowOptions = {},
): AgentHistoryEntry[] {
  if (messages.length === 0) return [];
  const maxBytes = options.maxBytes ?? MAX_AGENT_HISTORY_BYTES;
  const maxMessageBytes = options.maxMessageBytes ?? MAX_AGENT_HISTORY_MESSAGE_BYTES;
  const minMessages = options.minMessages ?? MIN_AGENT_HISTORY_MESSAGES;

  const window: AgentHistoryEntry[] = [];
  let bytes = 0;
  for (const message of messages) {
    let content = blocksToAgentHistoryText(message.blocks as MessageBlock[]);
    if (byteLength(content) > maxMessageBytes) {
      content =
        truncateUtf8(content, Math.max(0, maxMessageBytes - byteLength(TRUNCATION_SUFFIX))) +
        TRUNCATION_SUFFIX;
    }
    const size = byteLength(content);
    if (window.length > 0 && window.length >= minMessages && bytes + size > maxBytes) break;
    window.unshift({ role: roleOf(message.role), content });
    bytes += size;
  }
  return window;
}

function roleOf(role: string): "user" | "assistant" | "system" {
  if (role === "user") return "user";
  if (role === "system") return "system";
  return "assistant";
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const characters: string[] = [];
  let bytes = 0;
  for (const character of value) {
    const characterBytes = byteLength(character);
    if (bytes + characterBytes > maxBytes) break;
    characters.push(character);
    bytes += characterBytes;
  }
  return characters.join("");
}
