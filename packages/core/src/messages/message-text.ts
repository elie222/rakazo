import type { MessageBlock } from "@rakazo/contracts";
import { messagingProviderLabel } from "../messaging/messaging-providers.js";

/** A relayed chat-app message with who sent it and over what. */
export function channelMessageLine(
  block: Extract<MessageBlock, { kind: "channel_message" }>,
): string {
  return `${block.fromLabel} (${messagingProviderLabel(block.provider, block.transport)}): ${block.text}`;
}

/** Plain text for an email reply card: subject and body when present. */
function emailReplyLine(block: Extract<MessageBlock, { kind: "email_reply" }>): string {
  const subject = block.subject.trim();
  const body = block.body.trim();
  if (subject && body) return `${subject}\n${body}`;
  return subject || body;
}

/** The message's text exactly as written (text, ask and progress, no chrome), for selection. */
export function selectableMessageText(message: { blocks: readonly MessageBlock[] }): string {
  return message.blocks
    .map((block) => {
      if (block.kind === "channel_message") return channelMessageLine(block);
      if (block.kind === "email_reply") return emailReplyLine(block);
      if (block.kind === "text" || block.kind === "progress" || block.kind === "ask")
        return block.text;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

/** Plain message text for clipboard copy. */
export function copyableMessageText(message: { blocks: readonly MessageBlock[] }): string {
  return selectableMessageText(message).trim();
}
