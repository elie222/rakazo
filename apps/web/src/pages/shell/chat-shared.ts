import { t } from "@lingui/core/macro";
import type { ThreadMessage } from "@rakazo/contracts";
import { plainTextFromMarkdown, replyAttachment } from "@rakazo/core";

export type PendingAttachment = {
  id: string;
  threadKey: string;
  file: File;
  previewUrl?: string;
};

/** Identity colour for bots the roster no longer knows about. */
export const FALLBACK_BOT_COLOR = "#85858A";
export function previewMessageText(message: ThreadMessage): string {
  const text = message.blocks
    .map((block) => {
      if (block.kind === "channel_message") return block.text;
      if (block.kind === "text") {
        // Bot text is Markdown; user text is already plain.
        return message.role === "bot" ? plainTextFromMarkdown(block.text) : block.text;
      }
      return "";
    })
    .filter(Boolean)
    .join(" ")
    .trim();
  if (text) return text;
  const attachment = replyAttachment(message.blocks);
  if (attachment) return attachment.kind === "image" ? t`Photo` : attachment.name || t`Attachment`;
  return t`Message`;
}
