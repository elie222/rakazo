import type { ReplyPreview } from "@rakazo/contracts";
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
