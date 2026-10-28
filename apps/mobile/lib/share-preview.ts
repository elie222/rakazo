import type { IncomingShare } from "./incoming-share";

/** Preview source URIs directly: choosing a target must not copy or read entire files. */
export function sharePreview(share: IncomingShare) {
  const images = share.files.filter((file) => file.mimeType?.startsWith("image/"));
  const files = share.files.filter((file) => !file.mimeType?.startsWith("image/"));
  return {
    text: share.text,
    images: images.slice(0, 4),
    extraImages: Math.max(0, images.length - 4),
    fileCount: files.length,
    fileName: files.length === 1 ? (files[0]?.name ?? null) : null,
  };
}
