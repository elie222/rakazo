import type { AttachmentMimeType } from "@rakazo/contracts";
import { ATTACHMENT_MAX_BYTES, ATTACHMENT_MAX_COUNT, attachmentSizeLabel } from "@rakazo/contracts";

export type PickedAttachment = {
  id: string;
  name: string;
  mimeType: AttachmentMimeType;
  contentBase64: string;
  previewUri?: string;
};

export type PickSkip = { name: string; reason: string };

/**
 * Why a candidate cannot become an attachment, or null when it can. Callers can
 * ask before reading the content, so a rejected file is never loaded.
 */
export function attachmentSkipReason(
  candidate: { name: string; size: number; mimeType: string | null },
  existingCount: number,
  acceptedCount: number,
  maxBytes = ATTACHMENT_MAX_BYTES,
): string | null {
  if (existingCount + acceptedCount >= ATTACHMENT_MAX_COUNT) {
    return `max ${ATTACHMENT_MAX_COUNT} attachments`;
  }
  if (candidate.size > maxBytes) return `over ${attachmentSizeLabel(maxBytes)}`;
  if (!candidate.mimeType) return "unsupported type";
  return null;
}

export function filterPickedAttachments(
  existingCount: number,
  candidates: Array<{
    name: string;
    mimeType: string | null;
    size: number;
    contentBase64: string;
    previewUri?: string;
  }>,
  maxBytes = ATTACHMENT_MAX_BYTES,
): { attachments: PickedAttachment[]; skipped: PickSkip[] } {
  const attachments: PickedAttachment[] = [];
  const skipped: PickSkip[] = [];
  for (const candidate of candidates) {
    const reason = attachmentSkipReason(candidate, existingCount, attachments.length, maxBytes);
    if (reason) {
      skipped.push({ name: candidate.name, reason });
      continue;
    }
    attachments.push({
      id: `${candidate.name}-${candidate.size}-${existingCount + attachments.length}`,
      name: candidate.name,
      mimeType: candidate.mimeType as AttachmentMimeType,
      contentBase64: candidate.contentBase64,
      previewUri: candidate.previewUri,
    });
  }
  return { attachments, skipped };
}
