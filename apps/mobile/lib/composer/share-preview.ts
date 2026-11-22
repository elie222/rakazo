import { inferAttachmentMimeType } from "@rakazo/core";
import type { IncomingShare } from "./incoming-share";

/** Preview source URIs directly: choosing a target must not copy or read entire files. */
export function sharePreview(share: IncomingShare) {
  const images: IncomingShare["files"] = [];
  const files: IncomingShare["files"] = [];
  for (const file of share.files) {
    const mimeType =
      file.mimeType && file.mimeType !== "application/octet-stream"
        ? file.mimeType
        : (inferAttachmentMimeType(file.name) ??
          inferAttachmentMimeType(file.uri.split(/[?#]/, 1)[0] ?? ""));
    (mimeType?.startsWith("image/") ? images : files).push(file);
  }
  return {
    text: share.text,
    images: images.slice(0, 4),
    extraImages: Math.max(0, images.length - 4),
    fileCount: files.length,
    fileName: files.length === 1 ? (files[0]?.name ?? null) : null,
  };
}
