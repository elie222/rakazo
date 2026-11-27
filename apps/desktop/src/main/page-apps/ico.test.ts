import { describe, expect, it } from "vitest";
import { writeIco } from "./ico.js";

const png = (size: number) => Buffer.alloc(10 + size / 16, size % 255);

describe("writeIco", () => {
  it("lists each PNG with its size and where its bytes start", () => {
    const images = new Map([16, 256, 1024].map((size) => [size, png(size)]));
    const ico = writeIco(images);
    expect([ico.readUInt16LE(0), ico.readUInt16LE(2), ico.readUInt16LE(4)]).toEqual([0, 1, 2]);
    const entry = (index: number) => {
      const at = 6 + 16 * index;
      const length = ico.readUInt32LE(at + 8);
      const offset = ico.readUInt32LE(at + 12);
      return {
        width: ico.readUInt8(at),
        height: ico.readUInt8(at + 1),
        bits: ico.readUInt16LE(at + 6),
        bytes: ico.subarray(offset, offset + length),
      };
    };
    expect(entry(0)).toEqual({ width: 16, height: 16, bits: 32, bytes: images.get(16) });
    expect(entry(1)).toEqual({ width: 0, height: 0, bits: 32, bytes: images.get(256) });
    expect(ico.length).toBe(6 + 32 + png(16).length + png(256).length);
  });

  it("refuses to write an icon with no usable size", () => {
    expect(() => writeIco(new Map([[1024, png(1024)]]))).toThrow();
  });
});
