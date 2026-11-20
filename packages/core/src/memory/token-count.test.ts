import { describe, expect, it } from "vitest";
import { memoryTokenCount } from "./token-count.js";

describe("memoryTokenCount", () => {
  it("counts each CJK character as one token", () => {
    expect(memoryTokenCount("你好世界")).toBe(4);
    expect(memoryTokenCount("こんにちは")).toBe(5);
    expect(memoryTokenCount("안녕하세요")).toBe(5);
    expect(memoryTokenCount("。、！？")).toBe(4);
  });

  it("counts four other characters as one token, rounded up", () => {
    expect(memoryTokenCount("")).toBe(0);
    expect(memoryTokenCount("one")).toBe(1);
    expect(memoryTokenCount("four")).toBe(1);
    expect(memoryTokenCount("five!")).toBe(2);
  });

  it("adds the two scripts together", () => {
    expect(memoryTokenCount("你好 world")).toBe(2 + 2);
  });
});
