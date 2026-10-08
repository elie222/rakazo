import type { MessageBlock, ReplyPreview } from "@rakazo/contracts";
import { ReplyPreviewSchema } from "@rakazo/contracts";

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
