import { describe, expect, it } from "vitest";
import { BotEmailNameSchema, suggestedEmailName } from "./bot-email.js";

describe("suggestedEmailName", () => {
  it("turns a bot name into an address name the server accepts", () => {
    for (const [name, expected] of [
      ["Research Helper", "research-helper"],
      ["Müller's Bot!", "muller-s-bot"],
      ["  Zoë  ", "zoe"],
    ] as const) {
      expect(suggestedEmailName(name)).toBe(expected);
      expect(BotEmailNameSchema.safeParse(suggestedEmailName(name)).success).toBe(true);
    }
  });

  it("drops what an address cannot hold", () => {
    expect(suggestedEmailName("研究")).toBe("");
    expect(suggestedEmailName("a".repeat(80))).toHaveLength(64);
  });
});
