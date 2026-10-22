import type { MessageBlock } from "@rakazo/contracts";
import type { Prisma } from "./client.js";

/** Text only: progress, commands, secret prompts and tool traces are not retrieval content. */
export function historyMessageText(blocks: Prisma.JsonValue): string {
  if (!Array.isArray(blocks)) return "";
  return (
    blocks.filter(
      (block) => block && typeof block === "object" && !Array.isArray(block),
    ) as MessageBlock[]
  )
    .flatMap((block) => {
      if (block.kind === "subagent") return [block.task, block.result ?? ""].filter(Boolean);
      return [
        "text",
        "channel_message",
        "bot_message_received",
        "bot_message_sent",
        "handoff",
      ].includes(block.kind) &&
        "text" in block &&
        typeof block.text === "string"
        ? [block.text]
        : [];
    })
    .join("\n");
}
