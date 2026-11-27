import type { MessageBlock } from "@rakazo/contracts";
import { messagingProviderLabel } from "../messaging/messaging-providers.js";

/** A relayed chat-app message with who sent it and over what. */
export function channelMessageLine(
  block: Extract<MessageBlock, { kind: "channel_message" }>,
): string {
  return `${block.fromLabel} (${messagingProviderLabel(block.provider, block.transport)}): ${block.text}`;
}

/** The message's text exactly as written (text, ask and progress, no chrome), for selection. */
export function selectableMessageText(message: { blocks: readonly MessageBlock[] }): string {
  return message.blocks
    .map((block) => {
      if (block.kind === "channel_message") return channelMessageLine(block);
      if (block.kind === "text" || block.kind === "progress" || block.kind === "ask")
        return block.text;
      if (block.kind === "card") {
        return block.lines.map((line) => `${line.k} → ${line.v}`).join("\n");
      }
      if (block.kind === "result_cards") {
        const rows = block.items.map((item) =>
          [item.title, item.subtitle, item.price, item.rating, item.url]
            .filter(Boolean)
            .join(" · "),
        );
        return [block.title, ...rows].filter(Boolean).join("\n");
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

/** Plain message text for clipboard copy. */
export function copyableMessageText(message: { blocks: readonly MessageBlock[] }): string {
  return selectableMessageText(message).trim();
}

/** Several messages for one clipboard copy, in the order given, a blank line between them. */
export function copyableMessagesText(
  messages: readonly { blocks: readonly MessageBlock[] }[],
): string {
  return messages.map(copyableMessageText).filter(Boolean).join("\n\n");
}
