const IMAGE_TILE_PIXELS = 32;
const IMAGE_TOKENS_PER_TILE = 16;
const MIN_IMAGE_TOKENS = 1024;
const MAX_IMAGE_HEADER_BASE64 = 350_000;

/** Inspect only image headers. Unsupported or malformed data keeps the byte-based budget. */
function imageDimensions(bytes: Buffer, mimeType: string): [number, number] | undefined {
  if (mimeType === "image/png") {
    if (
      bytes.length < 33 ||
      !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
      bytes.readUInt32BE(8) !== 13 ||
      bytes.toString("ascii", 12, 16) !== "IHDR"
    )
      return;
    const dimensions: [number, number] = [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
    // APNG frame count lives in acTL before the first IDAT. If that portion of
    // the header does not fit the bounded read, retain the byte fallback.
    let offset = 33;
    while (offset + 8 <= bytes.length) {
      const length = bytes.readUInt32BE(offset);
      const type = bytes.toString("ascii", offset + 4, offset + 8);
      if (type === "acTL" || type === "IEND") return;
      if (type === "IDAT") return dimensions;
      const next = offset + 12 + length;
      if (!Number.isSafeInteger(next) || next > bytes.length) return;
      offset = next;
    }
    return;
  }
  if (mimeType === "image/gif") return; // Frame count is unknown from its header.
  if (mimeType === "image/webp") {
    if (
      bytes.length < 30 ||
      bytes.toString("ascii", 0, 4) !== "RIFF" ||
      bytes.toString("ascii", 8, 12) !== "WEBP"
    )
      return;
    const format = bytes.toString("ascii", 12, 16);
    if (format === "VP8X") {
      if ((bytes[20]! & 0x02) !== 0) return; // Animated WebP.
      return [1 + bytes.readUIntLE(24, 3), 1 + bytes.readUIntLE(27, 3)];
    }
    if (format === "VP8L" && bytes[20] === 0x2f) {
      const dimensions = bytes.readUInt32LE(21);
      return [1 + (dimensions & 0x3fff), 1 + ((dimensions >>> 14) & 0x3fff)];
    }
    if (format === "VP8 " && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a)
      return [bytes.readUInt16LE(26) & 0x3fff, bytes.readUInt16LE(28) & 0x3fff];
    return;
  }
  if (mimeType !== "image/jpeg" || bytes[0] !== 0xff || bytes[1] !== 0xd8) return;
  let offset = 2;
  while (offset + 4 < bytes.length) {
    if (bytes[offset++] !== 0xff) return;
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === undefined || marker === 0xda || marker === 0xd9) return;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
    if (offset + 2 > bytes.length) return;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) return;
    if (
      length >= 7 &&
      ((marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf))
    )
      return [bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3)];
    offset += length;
  }
}

/** Conservative pixel-based context planning, independent of provider billing. */
export function estimatePiImageTokens(image: object): number | undefined {
  if (!("data" in image) || typeof image.data !== "string") return;
  if (!("mimeType" in image) || typeof image.mimeType !== "string") return;
  // JPEG metadata can precede the frame header; avoid decoding a full image each model call.
  const header = Buffer.from(image.data.slice(0, MAX_IMAGE_HEADER_BASE64), "base64");
  const dimensions = imageDimensions(header, image.mimeType);
  if (!dimensions || dimensions.some((dimension) => !Number.isInteger(dimension) || dimension < 1))
    return;
  const [width, height] = dimensions;
  const tiles = Math.ceil(width / IMAGE_TILE_PIXELS) * Math.ceil(height / IMAGE_TILE_PIXELS);
  if (!Number.isSafeInteger(tiles) || tiles > Number.MAX_SAFE_INTEGER / IMAGE_TOKENS_PER_TILE)
    return Number.MAX_SAFE_INTEGER;
  // This planning estimate exceeds published rates for common providers;
  // actual usage remains provider-reported and may differ.
  return Math.max(MIN_IMAGE_TOKENS, tiles * IMAGE_TOKENS_PER_TILE);
}
