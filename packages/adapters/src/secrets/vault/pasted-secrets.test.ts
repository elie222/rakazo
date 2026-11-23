import { describe, expect, it } from "vitest";
import { swapPastedValues } from "./pasted-secrets.js";

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
});
