import { describe, expect, it } from "vitest";
import { parsePlotData } from "./plot-spec.js";

describe("parsePlotData blank lines", () => {
  it("ignores a trailing blank line in CSV", () => {
    expect(parsePlotData("data.csv", "a,b\n1,2\n\n")).toEqual([{ a: 1, b: 2 }]);
  });

  it("ignores a blank line between CSV rows", () => {
    expect(parsePlotData("data.csv", "a,b\n1,2\n\n3,4\n")).toEqual([
      { a: 1, b: 2 },
      { a: 3, b: 4 },
    ]);
  });

  it("ignores a trailing blank line in TSV", () => {
    expect(parsePlotData("data.tsv", "a\tb\n1\t2\n\n")).toEqual([{ a: 1, b: 2 }]);
  });

  it("ignores a blank line between TSV rows", () => {
    expect(parsePlotData("data.tsv", "a\tb\n1\t2\n\n3\t4\n")).toEqual([
      { a: 1, b: 2 },
      { a: 3, b: 4 },
    ]);
  });

  it("ignores a whitespace-only line in multi-column CSV and TSV", () => {
    expect(parsePlotData("data.csv", "a,b\n1,2\n  \n3,4")).toEqual([
      { a: 1, b: 2 },
      { a: 3, b: 4 },
    ]);
    expect(parsePlotData("data.tsv", "a\tb\n1\t2\n  \n3\t4")).toEqual([
      { a: 1, b: 2 },
      { a: 3, b: 4 },
    ]);
  });

  it("keeps the empty row for a single-column CSV, where a blank line is ambiguous", () => {
    expect(parsePlotData("data.csv", "a\n1\n\n2\n")).toEqual([{ a: 1 }, { a: null }, { a: 2 }]);
  });
});
