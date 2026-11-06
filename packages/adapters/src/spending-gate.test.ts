import { describe, expect, it } from "vitest";
import { paysWithWallet } from "./spending-gate.js";

describe("paysWithWallet", () => {
  const click = { kind: "click", ref: "e9" };
  it.each([
    ["a wallet card", [{ kind: "fill_card", purchase: "p-1", field: "number" }, click], true],
    ["a wallet pay token", [{ kind: "fill_pay_token", purchase: "p-1" }, click], true],
    ["a saved card", [{ kind: "fill_card", card: "visa", site: "https://a.test" }, click], false],
    // Either card may be the one that pays, so the click still counts.
    [
      "a wallet card beside a saved card",
      [
        { kind: "fill_card", purchase: "p-1", field: "number" },
        { kind: "fill_card", card: "visa", site: "https://a.test", field: "cvc" },
        click,
      ],
      false,
    ],
    ["no card", [click], false],
  ])("pays with %s: %s", (_case, actions, expected) => {
    expect(paysWithWallet({ actions })).toBe(expected);
  });
});
