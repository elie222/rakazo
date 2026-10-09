import { describe, expect, it } from "vitest";
import { formatFileSize } from "./format-file-size.js";

describe("formatFileSize", () => {
  it("uses whole units and one decimal only when needed", () => {
    expect(formatFileSize(0)).toBe("0 B");
    expect(formatFileSize(512)).toBe("512 B");
    expect(formatFileSize(1024)).toBe("1 KB");
    expect(formatFileSize(2048)).toBe("2 KB");
    expect(formatFileSize(1536)).toBe("1.5 KB");
    expect(formatFileSize(Math.round(1.4 * 1024 * 1024))).toBe("1.4 MB");
    expect(formatFileSize(3 * 1024 * 1024)).toBe("3 MB");
  });

  it("rolls a rounded 1024 up to the next unit", () => {
    expect(formatFileSize(1024 * 1024 - 1)).toBe("1 MB");
  });

  it("returns nothing for an unknown size", () => {
    expect(formatFileSize(Number.NaN)).toBe("");
    expect(formatFileSize(Number.POSITIVE_INFINITY)).toBe("");
    expect(formatFileSize(-1)).toBe("");
  });
});
