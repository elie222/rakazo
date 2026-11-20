import { describe, expect, it } from "vitest";
import { BotSchema, UpdateBotInput } from "./bot.js";

describe("UpdateBotInput approvalMode", () => {
  const botId = `c${"a".repeat(24)}`;

  it("accepts a mode, clears with null, and stays absent when omitted", () => {
    expect(UpdateBotInput.parse({ botId, approvalMode: "never" }).approvalMode).toBe("never");
    expect(UpdateBotInput.parse({ botId, approvalMode: null }).approvalMode).toBeNull();
    expect(UpdateBotInput.parse({ botId }).approvalMode).toBeUndefined();
  });

  it("refuses an unknown mode", () => {
    expect(UpdateBotInput.safeParse({ botId, approvalMode: "sometimes" }).success).toBe(false);
  });
});

describe("BotSchema approvalMode", () => {
  it("defaults to following the Space", () => {
    expect(BotSchema.pick({ approvalMode: true }).parse({})).toEqual({ approvalMode: null });
    expect(BotSchema.pick({ approvalMode: true }).parse({ approvalMode: "auto" })).toEqual({
      approvalMode: "auto",
    });
  });
});
