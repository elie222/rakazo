import { describe, expect, it } from "vitest";
import {
  BotSchema,
  conversationCompactionTokenThreshold,
  DEFAULT_CUSTOM_CONVERSATION_COMPACTION_TOKENS,
  UpdateBotInput,
} from "./bot.js";

const botId = `c${"a".repeat(24)}`;

describe("conversationCompactionTokenThreshold", () => {
  it("keeps the message-count behavior when no token threshold applies", () => {
    expect(conversationCompactionTokenThreshold(undefined, null, 200_000)).toBeNull();
    expect(conversationCompactionTokenThreshold("automatic", null, 200_000)).toBeNull();
    expect(conversationCompactionTokenThreshold("earlier", null, null)).toBeNull();
  });

  it("uses a share of the model window for the presets", () => {
    expect(conversationCompactionTokenThreshold("earlier", null, 200_000)).toBe(100_000);
    expect(conversationCompactionTokenThreshold("near_limit", null, 200_000)).toBe(160_000);
  });

  it("keeps a custom threshold below the model's 90% ceiling", () => {
    expect(conversationCompactionTokenThreshold("custom", 120_000, 200_000)).toBe(120_000);
    expect(conversationCompactionTokenThreshold("custom", null, 200_000)).toBe(
      DEFAULT_CUSTOM_CONVERSATION_COMPACTION_TOKENS,
    );
    expect(conversationCompactionTokenThreshold("custom", 1_000_000, 200_000)).toBe(180_000);
    expect(conversationCompactionTokenThreshold("custom", 20_000, 10_000)).toBe(9_000);
  });
});

describe("conversation compaction settings", () => {
  it("accepts each mode and an in-range custom token threshold", () => {
    for (const conversationCompactionMode of ["automatic", "earlier", "near_limit", "custom"]) {
      expect(
        UpdateBotInput.parse({ botId, conversationCompactionMode }).conversationCompactionMode,
      ).toBe(conversationCompactionMode);
    }
    expect(
      UpdateBotInput.parse({ botId, conversationCompactionTokens: 120_000 })
        .conversationCompactionTokens,
    ).toBe(120_000);
    expect(
      UpdateBotInput.parse({ botId, conversationCompactionTokens: null })
        .conversationCompactionTokens,
    ).toBeNull();
  });

  it("refuses an unknown mode and a threshold outside 20K through 1M", () => {
    expect(UpdateBotInput.safeParse({ botId, conversationCompactionMode: "always" }).success).toBe(
      false,
    );
    for (const conversationCompactionTokens of [19_999, 1_000_001, 12.5])
      expect(UpdateBotInput.safeParse({ botId, conversationCompactionTokens }).success).toBe(false);
  });

  it("reads older bots without the settings as automatic", () => {
    expect(
      BotSchema.pick({
        conversationCompactionMode: true,
        conversationCompactionTokens: true,
        maxToolCallsPerTurn: true,
      }).parse({}),
    ).toEqual({});
  });
});

describe("maxToolCallsPerTurn", () => {
  it("accepts a positive whole number, clears with null, and stays absent when omitted", () => {
    expect(UpdateBotInput.parse({ botId, maxToolCallsPerTurn: 1 }).maxToolCallsPerTurn).toBe(1);
    expect(UpdateBotInput.parse({ botId, maxToolCallsPerTurn: 400 }).maxToolCallsPerTurn).toBe(400);
    expect(
      UpdateBotInput.parse({ botId, maxToolCallsPerTurn: null }).maxToolCallsPerTurn,
    ).toBeNull();
    expect(UpdateBotInput.parse({ botId }).maxToolCallsPerTurn).toBeUndefined();
  });

  it("refuses zero, an excessive count, and fractions", () => {
    for (const maxToolCallsPerTurn of [0, 1_001, 2.5])
      expect(UpdateBotInput.safeParse({ botId, maxToolCallsPerTurn }).success).toBe(false);
  });
});
