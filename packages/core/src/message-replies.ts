import type { MessageBlock, ReplyPreview } from "@rakazo/contracts";
import { ReplyPreviewSchema } from "@rakazo/contracts";
import { displayName } from "./display-name.js";
import { plainTextFromMarkdown } from "./markdown-plain.js";

type ReplyMetadata = {
  replyToMessageId?: string;
  replyQuote?: string;
  replyPreview?: ReplyPreview | null;
};

/** Updates may omit reply metadata; retain it until an authoritative value arrives. */
export function replyMetadata(
  payload: Record<string, unknown>,
  previous?: ReplyMetadata,
): ReplyMetadata {
  const preview = ReplyPreviewSchema.nullable().safeParse(payload.replyPreview);
  return {
    replyToMessageId:
      typeof payload.replyToMessageId === "string"
        ? payload.replyToMessageId
        : previous?.replyToMessageId,
    replyQuote: typeof payload.replyQuote === "string" ? payload.replyQuote : previous?.replyQuote,
    replyPreview: preview.success ? preview.data : previous?.replyPreview,
  };
}

export function replyLineText(quote?: string, preview?: string, fallback?: string): string {
  return quote ? quote.replace(/\s+/gu, " ") : (preview || fallback || "").split(/\r?\n/u)[0] || "";
}

/** Pick only metadata from validated parent blocks, preferring a photo over a file. */
export function replyAttachment(blocks: MessageBlock[]): ReplyPreview["attachment"] {
  const block =
    blocks.find((block) => block.kind === "image") ?? blocks.find((block) => block.kind === "file");
  if (!block || (block.kind !== "image" && block.kind !== "file")) return undefined;
  return {
    kind: block.kind,
    artifactId: block.artifactId,
    mimeType: block.mimeType,
    name: block.name,
  };
}

export function replyLabel(
  quote: string | null | undefined,
  text: string | undefined,
  attachment: ReplyPreview["attachment"],
  labels: { photo: string; attachment: string },
): string {
  // Older sends persisted the image filename/agent placeholder as a quote.
  const legacyImageQuote =
    attachment?.kind === "image" &&
    !text &&
    (quote === attachment.name || quote === `[image: ${attachment.name}]`);
  return replyLineText(
    legacyImageQuote ? undefined : (quote ?? undefined),
    text,
    attachment?.kind === "image" ? labels.photo : attachment?.name || labels.attachment,
  );
}

/**
 * Who wrote a message relayed from an outside channel. Those arrive as user messages, so a reply
 * to one names its sender rather than "You".
 */
export function channelMessageSender(blocks: MessageBlock[]): string | undefined {
  const block = blocks.find((candidate) => candidate.kind === "channel_message");
  return block?.kind === "channel_message"
    ? displayName(block.fromLabel, "") || undefined
    : undefined;
}

/**
 * A message's text for a reply line before the server's preview arrives. Channel
 * messages show their text alone, matching the server-owned preview.
 */
export function previewMessageText(
  message: { role: string; blocks: MessageBlock[] },
  labels: { photo: string; attachment: string; message: string },
): string {
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
  if (attachment)
    return attachment.kind === "image" ? labels.photo : attachment.name || labels.attachment;
  return labels.message;
}
