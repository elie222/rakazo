import { describe, expect, it } from "vitest";
import { runHoldsChat } from "./chat-holding-runs.js";

describe("runHoldsChat", () => {
  it("lets a routine running alongside its chat, silent or not, leave the chat free", () => {
    for (const trigger of ["routine", "silent_routine"]) {
      expect(runHoldsChat({ trigger, routine: { inChat: false } })).toBe(false);
      expect(runHoldsChat({ trigger, routine: { inChat: true } })).toBe(true);
    }
    expect(runHoldsChat({ trigger: "user", routine: null })).toBe(true);
  });
});
