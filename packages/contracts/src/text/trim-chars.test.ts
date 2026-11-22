import { describe, expect, it } from "vitest";
import { expectLinearTime } from "../testing/timing.test-support.js";
import { trimEndChars, trimStartChars } from "./trim-chars.js";

describe("trimEndChars", () => {
  it("removes only the trailing run", () => {
    expect(trimEndChars("a--b---", "-")).toBe("a--b");
    expect(trimEndChars("https://x.test//", "/")).toBe("https://x.test");
    expect(trimEndChars("---", "-")).toBe("");
    expect(trimEndChars("", "-")).toBe("");
  });

  it("stays fast on a long run that does not reach the end", () => {
    const text = `${"-".repeat(200_000)}a`;
    expectLinearTime(() => expect(trimEndChars(text, "-")).toBe(text));
  });
});

describe("trimStartChars", () => {
  it("removes only the leading run", () => {
    expect(trimStartChars("//a/b", "/")).toBe("a/b");
    expect(trimStartChars("ab", "/")).toBe("ab");
  });
});
