import type { MessageBlock } from "@rakazo/contracts";
import { messagingProviderLabel } from "../messaging/messaging-providers.js";
import { isDeliveryMessage, isPeerReceiptBlocks } from "./message-visibility.js";

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

/** A reply's text blocks only, never cards, files, questions, step notes or tool activity. */
function replyTextBlocks(message: { blocks: readonly MessageBlock[] }): string {
  // Reads stored rows too, whose text may not be a string.
  return message.blocks
    .flatMap((block) => {
      const text = block.kind === "text" && typeof block.text === "string" ? block.text.trim() : "";
      return text ? [text] : [];
    })
    .join("\n\n");
}

/**
 * Exactly what a bot reply's public link shows, as plain text: its text blocks with `redact`
 * (the logging package's `redactSensitiveText`) applied, so the share dialog and the public page
 * show the same words.
 */
export function sharedReplyText(
  message: { blocks: readonly MessageBlock[] },
  redact: (text: string) => string,
): string {
  return redact(replyTextBlocks(message));
}

/**
 * Whether a message can get a public link: a saved bot reply to the people in the chat, with text
 * to show. Live and synthetic rows (their ids hold a `:`) are not saved messages, and what woke a
 * bot or passed between bots is not a reply.
 */
export function canShareReply(message: {
  id: string;
  role: string;
  blocks: readonly MessageBlock[];
}): boolean {
  return (
    message.role === "bot" &&
    !message.id.includes(":") &&
    !isDeliveryMessage(message.blocks) &&
    !isPeerReceiptBlocks(message.blocks) &&
    replyTextBlocks(message) !== ""
  );
}
