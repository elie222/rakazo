import { describe, expect, it, vi } from "vitest";
import { wordsFor } from "../labels.js";
import { formatValue, valueScale } from "./shared.js";

describe("chart figure formatting", () => {
  it("keeps small nonzero percentage ticks distinct from zero and each other", () => {
    const { ticks } = valueScale([0, 0.001, 0.002], 0, 0.002);
    expect(ticks.map((value) => formatValue(value, "%"))).toEqual(["0%", "0.001%", "0.002%"]);
  });

  it("preserves the sign, decimal separator, and units of small figures", () => {
    const de = wordsFor("de");
    expect(formatValue(-0.0004, undefined, undefined, de)).toBe("-0,0004");
    expect(formatValue(0.0004234, "ms")).toBe("0.000423 ms");
    expect(formatValue(0.000001, undefined)).toBe("0.000001");
  });

  it("uses short scientific notation for extremely small values", () => {
    expect(formatValue(1.23456e-10, "%")).toBe("1.23E-10%");
    expect(formatValue(-1.23456e-10, undefined, undefined, wordsFor("de"))).toBe("-1,23E-10");
    expect(formatValue(Number.MIN_VALUE)).toBe("5E-324");
  });

  it("keeps the ordinary rounding, compact values, and unit placement", () => {
    expect(formatValue(0, "%")).toBe("0%");
    expect(formatValue(12.5, "ms")).toBe("12.5 ms");
    expect(formatValue(0.12345)).toBe("0.12");
    expect(formatValue(-12, "$")).toBe("-$12");
    expect(formatValue(1_250_000)).toBe("1.3M");
  });

  it("uses a supplied formatter before applying any default formatting", () => {
    const format = vi.fn(() => "custom");
    expect(formatValue(0.001, "%", format)).toBe("custom");
    expect(format).toHaveBeenCalledExactlyOnceWith(0.001);
    expect(formatValue(0.001, "%", () => 0)).toBe("0");
  });

  it("falls back to the default format if a supplied formatter throws", () => {
    expect(
      formatValue(0.001, "%", () => {
        throw new Error("Format unavailable");
      }),
    ).toBe("0.001%");
  });
});
