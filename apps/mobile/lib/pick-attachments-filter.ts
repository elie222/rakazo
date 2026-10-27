import type { AttachmentMimeType } from "@rakazo/contracts";
import { ATTACHMENT_MAX_BYTES, ATTACHMENT_MAX_COUNT, attachmentSizeLabel } from "@rakazo/contracts";
import { newClientId } from "@rakazo/core";

export type PickedAttachment = {
  id: string;
  name: string;
  mimeType: AttachmentMimeType;
  contentBase64: string;
  previewUri?: string;
};

export type PickSkip = { name: string; reason: string };

export function attachmentCountSkipReason(): string {
  return `max ${ATTACHMENT_MAX_COUNT} attachments`;
}

export function attachmentSizeSkipReason(maxBytes: number): string {
  return `over ${attachmentSizeLabel(maxBytes)}`;
}

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
    return attachmentCountSkipReason();
  }
  if (candidate.size > maxBytes) return attachmentSizeSkipReason(maxBytes);
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
    attachments.push(pickedAttachment(candidate));
  }
  return { attachments, skipped };
}

export function pickedAttachment(
  candidate: Parameters<typeof filterPickedAttachments>[1][number],
): PickedAttachment {
  return {
    id: newClientId(),
    name: candidate.name,
    mimeType: candidate.mimeType as AttachmentMimeType,
    contentBase64: candidate.contentBase64,
    previewUri: candidate.previewUri,
  };
}
