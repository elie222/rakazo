import { describe, expect, it } from "vitest";
import { isSquarePng, writeIcns } from "./icns.js";

function png(size: number): Buffer {
  const bytes = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(size, 16);
  bytes.writeUInt32BE(size, 20);
  return bytes;
}

function entries(icns: Buffer) {
  const found: [string, number][] = [];
  for (let at = 8; at < icns.length; at += icns.readUInt32BE(at + 4)) {
    found.push([icns.toString("ascii", at, at + 4), icns.readUInt32BE(at + 4) - 8]);
  }
  return found;
}

describe("writeIcns", () => {
  it("puts each PNG under every entry of its size, with lengths that add up", () => {
    const icns = writeIcns(new Map([32, 256, 1024].map((size) => [size, png(size)])));
    expect(icns.toString("ascii", 0, 4)).toBe("icns");
    expect(icns.readUInt32BE(4)).toBe(icns.length);
    expect(entries(icns)).toEqual([
      ["ic11", 33],
      ["ic13", 33],
      ["ic08", 33],
      ["ic10", 33],
    ]);
  });

  it("refuses to write an icon with no usable size", () => {
    expect(() => writeIcns(new Map([[48, png(48)]]))).toThrow();
  });
});

describe("isSquarePng", () => {
  it("reads the size from the PNG header and refuses anything else", () => {
    expect(isSquarePng(png(64), 64)).toBe(true);
    expect(isSquarePng(png(64), 128)).toBe(false);
    expect(isSquarePng(Buffer.from("not a png at all, just some text"), 64)).toBe(false);
  });
});
