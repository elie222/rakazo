import { describe, expect, it, vi } from "vitest";

vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray) => strings.join(""),
}));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: unknown }) => children,
  useLingui: () => ({ t: (strings: TemplateStringsArray) => strings.join("") }),
}));

import { BotEmailNameSchema } from "@rakazo/contracts";
import { suggestedEmailName } from "./RoutineEditor";

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
