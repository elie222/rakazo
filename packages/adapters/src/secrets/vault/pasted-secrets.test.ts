import { expectLinearTime } from "@rakazo/contracts/test-timing";
import { describe, expect, it } from "vitest";
import { MAX_PASTED_KEYS, swapPastedValues, TooManyPastedKeysError } from "./pasted-secrets.js";

// Synthetic values, built from parts so no scanner mistakes this file for a leak.
const first = ["sk", "-proj-", "Ab3dE5gH7jK9mN1pQ2rS4tU6vW8xY0zAb3dE5gH7"].join("");
const second = ["gh", "p_", "Ab3dE5gH7jK9mN1pQ2rS4tU6vW8xY0zAb3dE"].join("");

describe("swapPastedValues", () => {
  it("swaps each key for the variable it is saved as and keeps the rest", () => {
    const variables = new Map([
      [first, "PASTED_KEY"],
      [second, "PASTED_KEY_2"],
    ]);
    const text = `Use ${first} here,\n\`${second}\` there and ${first} again.`;
    expect(swapPastedValues(text, (value) => variables.get(value) ?? "")).toBe(
      "Use [saved as $PASTED_KEY] here,\n`[saved as $PASTED_KEY_2]` there and [saved as $PASTED_KEY] again.",
    );
  });

  it("also swaps the same value where it appears without its shape", () => {
    const token = "Ab3dE5gH7jK9mN1pQ2rS4tU6vW8xY0zA";
    expect(swapPastedValues(`Bearer ${token}\nTOKEN=${token}`, () => "PASTED_KEY")).toBe(
      "Bearer [saved as $PASTED_KEY]\nTOKEN=[saved as $PASTED_KEY]",
    );
  });

  it("swaps a repeated token even when its match joins a longer range", () => {
    const token = "Ab3dE5gH7jK9mN1pQ2rS4tU6vW8xY0zA";
    const block = ["-----BEGIN ", "RSA PRIVATE", " KEY-----\nBearer ", token].join("");
    expect(swapPastedValues(`TOKEN=${token}\n${block}`, () => "PASTED_KEY")).toBe(
      "TOKEN=[saved as $PASTED_KEY]\n[saved as $PASTED_KEY]",
    );
  });

  // Distinct keys of one shape.
  const keys = (count: number) =>
    Array.from(
      { length: count },
      (_, n) => `${second.slice(0, -6)}${String(n).padStart(6, "0")}`,
    ).join(" ");

  it("refuses a message with more keys than one message may save", () => {
    expect(swapPastedValues(keys(MAX_PASTED_KEYS), () => "KEY")).not.toContain(second.slice(0, 12));
    expect(() => swapPastedValues(keys(MAX_PASTED_KEYS + 1), () => "KEY")).toThrow(
      TooManyPastedKeysError,
    );
  });

  it("refuses a message of many distinct keys without searching for each one", () => {
    const text = keys(50_000);
    expectLinearTime(() =>
      expect(() => swapPastedValues(text, () => "KEY")).toThrow(TooManyPastedKeysError),
    );
  });
});
