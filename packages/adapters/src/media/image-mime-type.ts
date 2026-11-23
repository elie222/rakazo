import type { AttachmentImageMimeType } from "@rakazo/contracts";

/** Identify supported image formats from their headers without decoding pixels. */
export function detectImageMimeType(bytes: Uint8Array): AttachmentImageMimeType | undefined {
  const header = (start: number, end: number) => String.fromCharCode(...bytes.subarray(start, end));
  if (header(0, 8) === "\x89PNG\r\n\x1a\n") return "image/png";
  if (header(0, 3) === "\xff\xd8\xff") return "image/jpeg";
  const gif = header(0, 6);
  if (gif === "GIF87a" || gif === "GIF89a") return "image/gif";
  if (header(0, 4) === "RIFF" && header(8, 12) === "WEBP") return "image/webp";
  return undefined;
}
