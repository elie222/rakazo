/** Each icns entry that holds a PNG, by the pixel size of the image it takes. */
const ICNS_TYPES: [type: string, size: number][] = [
  ["ic11", 32],
  ["ic12", 64],
  ["ic07", 128],
  ["ic13", 256],
  ["ic08", 256],
  ["ic14", 512],
  ["ic09", 512],
  ["ic10", 1024],
];

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export const ICNS_SIZES = [...new Set(ICNS_TYPES.map(([, size]) => size))];

function header(type: string, length: number): Buffer {
  const bytes = Buffer.alloc(8);
  bytes.write(type, 0, "ascii");
  bytes.writeUInt32BE(length, 4);
  return bytes;
}

/** Whether the bytes are a PNG of that width and height, read from its header. */
export function isSquarePng(png: Buffer, size: number): boolean {
  return (
    png.length > 24 &&
    png.subarray(0, 8).equals(PNG_SIGNATURE) &&
    png.toString("ascii", 12, 16) === "IHDR" &&
    png.readUInt32BE(16) === size &&
    png.readUInt32BE(20) === size
  );
}

/** A macOS icon file holding the given PNGs; sizes it has no entry for are left out. */
export function writeIcns(pngs: ReadonlyMap<number, Buffer>): Buffer {
  const entries = ICNS_TYPES.flatMap(([type, size]) => {
    const png = pngs.get(size);
    return png ? [Buffer.concat([header(type, png.length + 8), png])] : [];
  });
  if (entries.length === 0) throw new Error("No icon image has a size an icns file holds.");
  const body = Buffer.concat(entries);
  return Buffer.concat([header("icns", body.length + 8), body]);
}
