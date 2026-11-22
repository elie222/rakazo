import { crc32, deflateSync } from "node:zlib";

/** The picture's content, as the judge rubric states it. */
export const SHAPES_PICTURE = "a red circle on the left and a blue square on the right";

/**
 * A 200x100 PNG of a red circle and a blue square on white, drawn here so the eval needs no
 * binary fixture and no image library.
 */
export function shapesPng(): Uint8Array {
  const width = 200;
  const height = 100;
  // One filter byte (0, none) before each row of RGB pixels.
  const rows = Buffer.alloc((width * 3 + 1) * height, 255);
  for (let y = 0; y < height; y += 1) {
    rows[y * (width * 3 + 1)] = 0;
    for (let x = 0; x < width; x += 1) {
      const circle = (x - 50) ** 2 + (y - 50) ** 2 <= 35 ** 2;
      const square = x >= 120 && x < 180 && y >= 20 && y < 80;
      if (!circle && !square) continue;
      const at = y * (width * 3 + 1) + 1 + x * 3;
      rows.set(circle ? [220, 30, 30] : [30, 60, 220], at);
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const typed = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(typed));
    return Buffer.concat([length, typed, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // Bit depth.
  header[9] = 2; // Truecolor RGB.
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
