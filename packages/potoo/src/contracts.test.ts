import { describe, expect, it } from "vitest";
import { parseReport } from "./contracts.js";

const QUIET =
  '```json\n{"findings": [], "back_page": [], "record": "quiet night: 212 passed, 0 failed"}\n```';

describe("parseReport", () => {
  it("parses a valid filing", () => {
    const report = parseReport(QUIET);
    expect(report?.findings).toEqual([]);
    expect(report?.record).toContain("quiet night");
  });

  it("returns null when the json block is missing", () => {
    expect(parseReport("no findings tonight")).toBeNull();
  });

  it("returns null on malformed json", () => {
    expect(parseReport("```json\n{not json}\n```")).toBeNull();
  });

  it("returns null when the schema is violated", () => {
    expect(parseReport('```json\n{"findings": "many"}\n```')).toBeNull();
  });
});
