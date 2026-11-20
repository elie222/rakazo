import { describe, expect, it } from "vitest";
import { BotSchema, UpdateBotInput } from "./bot.js";

describe("UpdateBotInput maxConcurrentHelpers", () => {
  const botId = `c${"a".repeat(24)}`;

  it("accepts 1 through 8, clears with null, and stays absent when omitted", () => {
    expect(UpdateBotInput.parse({ botId, maxConcurrentHelpers: 3 }).maxConcurrentHelpers).toBe(3);
    expect(UpdateBotInput.parse({ botId, maxConcurrentHelpers: 8 }).maxConcurrentHelpers).toBe(8);
    expect(
      UpdateBotInput.parse({ botId, maxConcurrentHelpers: null }).maxConcurrentHelpers,
    ).toBeNull();
    expect(UpdateBotInput.parse({ botId }).maxConcurrentHelpers).toBeUndefined();
  });

  it("refuses zero, nine, and fractions", () => {
    for (const value of [0, 9, 2.5])
      expect(UpdateBotInput.safeParse({ botId, maxConcurrentHelpers: value }).success).toBe(false);
  });
});

describe("BotSchema maxConcurrentHelpers", () => {
  it("defaults to the deployment's default", () => {
    expect(BotSchema.pick({ maxConcurrentHelpers: true }).parse({})).toEqual({
      maxConcurrentHelpers: null,
    });
    expect(
      BotSchema.pick({ maxConcurrentHelpers: true }).parse({ maxConcurrentHelpers: 5 }),
    ).toEqual({ maxConcurrentHelpers: 5 });
  });
});
