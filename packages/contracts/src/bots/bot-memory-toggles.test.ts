import { describe, expect, it } from "vitest";
import { BotSchema, UpdateBotInput } from "./bot.js";

describe("memory toggles", () => {
  const botId = `c${"a".repeat(24)}`;

  it("defaults both banks on", () => {
    expect(BotSchema.pick({ useOwnMemory: true, useSharedMemory: true }).parse({})).toEqual({
      useOwnMemory: true,
      useSharedMemory: true,
    });
  });

  it("turns one bank off and leaves the other absent", () => {
    expect(UpdateBotInput.parse({ botId, useOwnMemory: false }).useOwnMemory).toBe(false);
    expect(UpdateBotInput.parse({ botId, useSharedMemory: false }).useSharedMemory).toBe(false);
    expect(UpdateBotInput.parse({ botId }).useOwnMemory).toBeUndefined();
  });
});
