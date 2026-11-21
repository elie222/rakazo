const MAX_IMAGE_HEADER_BASE64 = 350_000;

/**
 * Width, height and frame count from a base64 image's header, or undefined when the header is
 * unsupported or malformed. JPEG metadata can precede the frame header, so a bounded prefix is
 * read rather than decoding the whole image.
 */
export function imageHeaderDimensions(
  base64: string,
  mimeType: string,
): [number, number, number] | undefined {
  const header = Buffer.from(base64.slice(0, MAX_IMAGE_HEADER_BASE64), "base64");
  const dimensions = imageDimensions(header, mimeType);
  if (!dimensions || dimensions.some((dimension) => !Number.isInteger(dimension) || dimension < 1))
    return;
  return dimensions;
}

function imageDimensions(bytes: Buffer, mimeType: string): [number, number, number] | undefined {
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
    let frames = 1;
    let sawAnimationControl = false;
    let firstFrameBeforeImageData = false;
    while (offset + 8 <= bytes.length) {
      const length = bytes.readUInt32BE(offset);
      const type = bytes.toString("ascii", offset + 4, offset + 8);
      if (type === "IEND") return;
      // A default image without an earlier fcTL is separate from acTL's animation frames.
      if (type === "IDAT")
        return [
          ...dimensions,
          sawAnimationControl && !firstFrameBeforeImageData ? frames + 1 : frames,
        ];
      const next = offset + 12 + length;
      if (!Number.isSafeInteger(next) || next > bytes.length) return;
      if (type === "acTL") {
        if (sawAnimationControl || length !== 8) return;
        frames = bytes.readUInt32BE(offset + 8);
        if (frames < 1) return;
        sawAnimationControl = true;
      }
      if (type === "fcTL" && sawAnimationControl) {
        if (length !== 26) return;
        firstFrameBeforeImageData = true;
      }
      offset = next;
    }
    return;
  }
  if (mimeType === "image/webp") {
    if (
      bytes.length < 30 ||
      bytes.toString("ascii", 0, 4) !== "RIFF" ||
      bytes.toString("ascii", 8, 12) !== "WEBP"
    )
      return;
    const format = bytes.toString("ascii", 12, 16);
    if (format === "VP8X") {
      if ((bytes[20]! & 0x02) !== 0) return; // Animated frames need the full RIFF chunk list.
      return [1 + bytes.readUIntLE(24, 3), 1 + bytes.readUIntLE(27, 3), 1];
    }
    if (format === "VP8L" && bytes[20] === 0x2f) {
      const dimensions = bytes.readUInt32LE(21);
      return [1 + (dimensions & 0x3fff), 1 + ((dimensions >>> 14) & 0x3fff), 1];
    }
    if (format === "VP8 " && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a)
      return [bytes.readUInt16LE(26) & 0x3fff, bytes.readUInt16LE(28) & 0x3fff, 1];
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
      return [bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3), 1];
    offset += length;
  }
}
