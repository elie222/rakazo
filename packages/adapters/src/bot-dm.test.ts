import { describe, expect, it } from "vitest";
import { botDmPairKey } from "./bot-dm.js";

describe("botDmPairKey", () => {
  it("orders bot ids deterministically", () => {
    expect(botDmPairKey("b", "a")).toBe("a:b");
    expect(botDmPairKey("a", "b")).toBe("a:b");
  });
});
