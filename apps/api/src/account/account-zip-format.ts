export const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
export const ZIP64_END_OF_CENTRAL_DIRECTORY = 0x06064b50;
export const ZIP64_END_OF_CENTRAL_DIRECTORY_LOCATOR = 0x07064b50;

// The importer holds one object and a copy of its name and extra fields per entry.
export const MAX_ARCHIVE_ENTRIES = 100_000;
export const MAX_CENTRAL_DIRECTORY_BYTES = 16 * 1024 * 1024;

/** fflate emits the whole central directory and its 22-byte footer as one final chunk. */
export function withZip64EntryCount(chunk: Uint8Array, entries: number) {
  if (entries < 0xffff) return chunk;
  const footerOffset = chunk.length - 22;
  const footer = new DataView(chunk.buffer, chunk.byteOffset + footerOffset, 22);
  if (footer.getUint32(0, true) !== END_OF_CENTRAL_DIRECTORY)
    throw new Error("The export ZIP has no end of central directory record.");
  const directorySize = footer.getUint32(12, true);
  const directoryOffset = footer.getUint32(16, true);
  const records = new Uint8Array(56 + 20);
  const view = new DataView(records.buffer);
  view.setUint32(0, ZIP64_END_OF_CENTRAL_DIRECTORY, true);
  view.setBigUint64(4, 44n, true);
  view.setUint16(12, 45, true);
  view.setUint16(14, 45, true);
  view.setBigUint64(24, BigInt(entries), true);
  view.setBigUint64(32, BigInt(entries), true);
  view.setBigUint64(40, BigInt(directorySize), true);
  view.setBigUint64(48, BigInt(directoryOffset), true);
  view.setUint32(56, ZIP64_END_OF_CENTRAL_DIRECTORY_LOCATOR, true);
  view.setBigUint64(64, BigInt(directoryOffset + directorySize), true);
  view.setUint32(72, 1, true);
  footer.setUint16(8, 0xffff, true);
  footer.setUint16(10, 0xffff, true);
  const updated = new Uint8Array(chunk.length + records.length);
  updated.set(chunk.subarray(0, footerOffset));
  updated.set(records, footerOffset);
  updated.set(chunk.subarray(footerOffset), footerOffset + records.length);
  return updated;
}
