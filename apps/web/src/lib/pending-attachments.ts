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

export function isFilePaste(
  clipboardData: Pick<DataTransfer, "files" | "items"> | null | undefined,
): boolean {
  if (!clipboardData) return false;
  return (
    (clipboardData.files?.length ?? 0) > 0 ||
    Array.from(clipboardData.items ?? []).some((item) => item.kind === "file")
  );
}

export function revokePendingAttachmentPreviews(
  attachments: readonly PendingAttachmentPreview[],
): void {
  for (const attachment of attachments) {
    if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
  }
}
