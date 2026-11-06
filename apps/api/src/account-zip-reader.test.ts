import { randomUUID } from "node:crypto";
import { open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Zip, ZipDeflate, ZipPassThrough } from "fflate";
import { describe, expect, it } from "vitest";
import { incompressibleBytes } from "./account-import.test-support.js";
import { crc32, inflateEntry, parseZipArchive, ZipFormatError } from "./account-zip-reader.js";

async function withArchive<T>(
  bytes: Uint8Array,
  run: (handle: Awaited<ReturnType<typeof open>>) => Promise<T>,
): Promise<T> {
  const file = path.join(tmpdir(), `rakazo-zip-reader-test-${randomUUID()}`);
  await writeFile(file, bytes);
  const handle = await open(file, "r+");
  try {
    return await run(handle);
  } finally {
    await handle.close();
    await rm(file, { force: true });
  }
}

function buildArchive(
  files: Array<[name: string, content: string | Uint8Array, stored?: boolean]>,
): Uint8Array {
  const chunks: Uint8Array[] = [];
  const zip = new Zip((error, chunk) => {
    if (error) throw error;
    chunks.push(chunk);
  });
  for (const [name, content, stored] of files) {
    const data = typeof content === "string" ? new TextEncoder().encode(content) : content;
    const entry = stored ? new ZipPassThrough(name) : new ZipDeflate(name, { level: 6 });
    zip.add(entry);
    entry.push(data, true);
  }
  zip.end();
  return Buffer.concat(chunks);
}

async function inflateAll(
  handle: Awaited<ReturnType<typeof open>>,
  name: string,
): Promise<Uint8Array> {
  const entries = await parseZipArchive(handle);
  const entry = entries.find((candidate) => candidate.name === name)!;
  const chunks: Uint8Array[] = [];
  await inflateEntry(handle, entry, (data) => {
    if (data.length) chunks.push(data);
  });
  return Buffer.concat(chunks);
}

/** A minimal ZIP64 archive, built by hand: one stored file, ZIP64 end of
 * central directory + locator, ZIP64 extra fields in both headers. */
function buildZip64Archive(): Uint8Array {
  const name = new TextEncoder().encode("a.txt");
  const data = new TextEncoder().encode("hi");
  const crc = crc32(data);
  const zip64Extra = new Uint8Array(20);
  const extraView = new DataView(zip64Extra.buffer);
  extraView.setUint16(0, 0x0001, true);
  extraView.setUint16(2, 16, true);
  extraView.setBigUint64(4, 2n, true);
  extraView.setBigUint64(12, 2n, true);
  const local = new Uint8Array(30 + name.length + zip64Extra.length + data.length);
  const localView = new DataView(local.buffer);
  localView.setUint32(0, 0x04034b50, true);
  localView.setUint16(4, 45, true);
  localView.setUint32(14, crc, true);
  localView.setUint32(18, 0xffffffff, true);
  localView.setUint32(22, 0xffffffff, true);
  localView.setUint16(26, name.length, true);
  localView.setUint16(28, zip64Extra.length, true);
  local.set(name, 30);
  local.set(zip64Extra, 30 + name.length);
  local.set(data, 30 + name.length + zip64Extra.length);
  const cdOffset = local.length;
  const cd = new Uint8Array(46 + name.length + zip64Extra.length);
  const cdView = new DataView(cd.buffer);
  cdView.setUint32(0, 0x02014b50, true);
  cdView.setUint16(4, 45, true);
  cdView.setUint16(6, 45, true);
  cdView.setUint32(16, crc, true);
  cdView.setUint32(20, 0xffffffff, true);
  cdView.setUint32(24, 0xffffffff, true);
  cdView.setUint16(28, name.length, true);
  cdView.setUint16(30, zip64Extra.length, true);
  cdView.setUint32(42, 0, true);
  cd.set(name, 46);
  cd.set(zip64Extra, 46 + name.length);
  const zip64EocdOffset = cdOffset + cd.length;
  const zip64Eocd = new Uint8Array(56);
  const zip64View = new DataView(zip64Eocd.buffer);
  zip64View.setUint32(0, 0x06064b50, true);
  zip64View.setBigUint64(4, 44n, true);
  zip64View.setUint16(12, 45, true);
  zip64View.setUint16(14, 45, true);
  zip64View.setBigUint64(24, 1n, true);
  zip64View.setBigUint64(32, 1n, true);
  zip64View.setBigUint64(40, BigInt(cd.length), true);
  zip64View.setBigUint64(48, BigInt(cdOffset), true);
  const locatorOffset = zip64EocdOffset + zip64Eocd.length;
  const locator = new Uint8Array(20);
  const locatorView = new DataView(locator.buffer);
  locatorView.setUint32(0, 0x07064b50, true);
  locatorView.setBigUint64(8, BigInt(zip64EocdOffset), true);
  locatorView.setUint32(16, 1, true);
  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  eocdView.setUint32(0, 0x06054b50, true);
  eocdView.setUint16(8, 0xffff, true);
  eocdView.setUint16(10, 0xffff, true);
  eocdView.setUint32(12, 0xffffffff, true);
  eocdView.setUint32(16, 0xffffffff, true);
  const out = new Uint8Array(
    local.length + cd.length + zip64Eocd.length + locator.length + eocd.length,
  );
  out.set(local, 0);
  out.set(cd, cdOffset);
  out.set(zip64Eocd, zip64EocdOffset);
  out.set(locator, locatorOffset);
  out.set(eocd, locatorOffset + locator.length);
  return out;
}

describe("account zip reader", () => {
  it("computes the standard CRC-32 check value", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array(0))).toBe(0);
  });

  it("parses entries in local-header order with their recorded sizes", async () => {
    const bytes = buildArchive([
      ["manifest.json", "{}"],
      ["spaces/s1/records.jsonl", "line\n"],
      ["spaces/s1/homes/b1/a.md", "hello"],
    ]);
    await withArchive(bytes, async (handle) => {
      const entries = await parseZipArchive(handle);
      expect(entries.map((entry) => [entry.name, entry.method, entry.uncompressedSize])).toEqual([
        ["manifest.json", 8, 2],
        ["spaces/s1/records.jsonl", 8, 5],
        ["spaces/s1/homes/b1/a.md", 8, 5],
      ]);
      expect(entries.every((entry) => entry.dataDescriptor)).toBe(true);
    });
  });

  it("inflates deflated and stored entries to their exact bytes", async () => {
    const stored = incompressibleBytes(1024);
    const bytes = buildArchive([
      ["deflated.txt", "hello".repeat(1000)],
      ["stored.bin", stored, true],
    ]);
    await withArchive(bytes, async (handle) => {
      expect(Buffer.from(await inflateAll(handle, "deflated.txt")).toString()).toBe(
        "hello".repeat(1000),
      );
      expect(Buffer.from(await inflateAll(handle, "stored.bin"))).toEqual(Buffer.from(stored));
    });
  });

  it("reads a ZIP64 archive", async () => {
    await withArchive(buildZip64Archive(), async (handle) => {
      const entries = await parseZipArchive(handle);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        name: "a.txt",
        method: 0,
        compressedSize: 2,
        uncompressedSize: 2,
        zip64Sizes: true,
      });
      expect(Buffer.from(await inflateAll(handle, "a.txt")).toString()).toBe("hi");
    });
  });

  it("rejects bytes that are not a zip and a truncated zip", async () => {
    const bytes = buildArchive([["manifest.json", "{}"]]);
    await expect(
      withArchive(new TextEncoder().encode("hello"), (handle) => parseZipArchive(handle)),
    ).rejects.toBeInstanceOf(ZipFormatError);
    await expect(
      withArchive(bytes.subarray(0, bytes.byteLength / 2), (handle) => parseZipArchive(handle)),
    ).rejects.toBeInstanceOf(ZipFormatError);
  });

  it("rejects an entry whose inflated bytes fail the recorded checksum", async () => {
    const bytes = buildArchive([
      ["manifest.json", "{}"],
      ["spaces/s1/records.jsonl", "line\n"],
    ]);
    const entries = await withArchive(bytes, (handle) => parseZipArchive(handle));
    const target = entries[1]!;
    const corrupted = new Uint8Array(bytes);
    corrupted[target.dataOffset] = corrupted[target.dataOffset]! ^ 0xff;
    await expect(
      withArchive(corrupted, (handle) => inflateAll(handle, "spaces/s1/records.jsonl")),
    ).rejects.toBeInstanceOf(ZipFormatError);
  });

  it("rejects an entry whose local header disagrees with the central directory", async () => {
    const bytes = buildArchive([
      ["manifest.json", "{}"],
      ["spaces/s1/records.jsonl", "line\n"],
    ]);
    const corrupted = new Uint8Array(bytes);
    // The second entry's local header starts at its data offset minus its
    // name length minus 30; flip a byte of the name itself.
    const entries = await withArchive(bytes, (handle) => parseZipArchive(handle));
    const target = entries[1]!;
    corrupted[target.localHeaderOffset + 30] = corrupted[target.localHeaderOffset + 30]! ^ 0xff;
    await expect(
      withArchive(corrupted, (handle) => parseZipArchive(handle)),
    ).rejects.toBeInstanceOf(ZipFormatError);
  });
});
