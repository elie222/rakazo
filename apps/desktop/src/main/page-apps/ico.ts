/** The sizes a Windows icon holds, each stored as a PNG. */
export const ICO_SIZES = [16, 32, 64, 128, 256];

const HEADER = 6;
const ENTRY = 16;

/** A Windows icon file holding the given PNGs; sizes it has no entry for are left out. */
export function writeIco(pngs: ReadonlyMap<number, Buffer>): Buffer {
  const images = ICO_SIZES.flatMap((size) => {
    const png = pngs.get(size);
    return png ? [{ size, png }] : [];
  });
  if (images.length === 0) throw new Error("No icon image has a size an ico file holds.");
  const header = Buffer.alloc(HEADER + ENTRY * images.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, png }, index) => {
    const at = HEADER + ENTRY * index;
    // A width or height of 256 is stored as 0.
    header.writeUInt8(size % 256, at);
    header.writeUInt8(size % 256, at + 1);
    header.writeUInt16LE(1, at + 4);
    header.writeUInt16LE(32, at + 6);
    header.writeUInt32LE(png.length, at + 8);
    header.writeUInt32LE(offset, at + 12);
    offset += png.length;
  });
  return Buffer.concat([header, ...images.map(({ png }) => png)]);
}
