export type PendingAttachmentPreview = {
  previewUrl?: string;
};

export function isFileDrag(dataTransfer: Pick<DataTransfer, "types" | "items"> | null): boolean {
  if (!dataTransfer) return false;
  return (
    Array.from(dataTransfer.types).includes("Files") ||
    Array.from(dataTransfer.items).some((item) => item.kind === "file")
  );
}

export function revokePendingAttachmentPreviews(
  attachments: readonly PendingAttachmentPreview[],
): void {
  for (const attachment of attachments) {
    if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
  }
}
