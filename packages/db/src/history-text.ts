import type { MessageBlock } from "@rakazo/contracts";
import type { Prisma } from "./client.js";

function objectBlocks(blocks: Prisma.JsonValue): MessageBlock[] {
  if (!Array.isArray(blocks)) return [];
  return blocks.filter(
    (block) => block && typeof block === "object" && !Array.isArray(block),
  ) as MessageBlock[];
}

/** Text only: progress, commands, secret prompts and tool traces are not retrieval content. */
export function historyMessageText(blocks: Prisma.JsonValue): string {
  return objectBlocks(blocks)
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

/** The files and images a message carries, as their blocks. */
export function historyAttachmentBlocks(
  blocks: Prisma.JsonValue,
): Array<Extract<MessageBlock, { kind: "file" | "image" }>> {
  return objectBlocks(blocks).filter(
    (block): block is Extract<MessageBlock, { kind: "file" | "image" }> =>
      (block.kind === "file" || block.kind === "image") &&
      typeof block.artifactId === "string" &&
      typeof block.name === "string",
  );
}

/** What history search matches: the message text plus the names of its attachments. */
export function historySearchText(blocks: Prisma.JsonValue): string {
  return [historyMessageText(blocks), ...historyAttachmentBlocks(blocks).map((block) => block.name)]
    .filter(Boolean)
    .join("\n");
}
