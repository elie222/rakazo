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
    if (existingCount + attachments.length >= ATTACHMENT_MAX_COUNT) {
      skipped.push({ name: candidate.name, reason: `max ${ATTACHMENT_MAX_COUNT} attachments` });
      continue;
    }
    if (candidate.size > maxBytes) {
      skipped.push({ name: candidate.name, reason: `over ${attachmentSizeLabel(maxBytes)}` });
      continue;
    }
    if (!candidate.mimeType) {
      skipped.push({ name: candidate.name, reason: "unsupported type" });
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
