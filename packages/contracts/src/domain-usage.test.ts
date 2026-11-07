import { describe, expect, it } from "vitest";
import { UsageSummaryInputSchema, UsageSummarySchema } from "./domain.js";

describe("UsageSummarySchema", () => {
  it("accepts bot breakdown and daily series", () => {
    const parsed = UsageSummarySchema.parse({
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      costUsd: 0.01,
      modelCalls: 3,
      runs: 2,
      models: [
        {
          provider: "openai-compatible",
          model: "deepseek-chat",
          inputTokens: 100,
          outputTokens: 50,
          totalTokens: 150,
          costUsd: 0.01,
          modelCalls: 3,
        },
      ],
      bots: [
        {
          botId: "bot-1",
          botName: "Muse",
          inputTokens: 100,
          outputTokens: 50,
          totalTokens: 150,
          costUsd: 0.01,
          modelCalls: 3,
        },
      ],
      daily: [
        {
          date: "2026-11-07",
          inputTokens: 100,
          outputTokens: 50,
          totalTokens: 150,
          costUsd: 0.01,
          modelCalls: 3,
        },
      ],
    });
    expect(parsed.bots?.[0]?.botName).toBe("Muse");
    expect(parsed.daily?.[0]?.date).toBe("2026-11-07");
  });

  it("accepts a summary without bots or daily", () => {
    const parsed = UsageSummarySchema.parse({
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      costUsd: 0.01,
      modelCalls: 3,
      runs: 2,
    });
    expect(parsed.bots).toBeUndefined();
    expect(parsed.daily).toBeUndefined();
  });
});

describe("UsageSummaryInputSchema", () => {
  it("accepts a day range and empty input", () => {
    expect(UsageSummaryInputSchema.parse({ days: 30 })).toEqual({ days: 30 });
    expect(UsageSummaryInputSchema.parse({})).toEqual({});
  });

  it("rejects out-of-range days", () => {
    expect(() => UsageSummaryInputSchema.parse({ days: 0 })).toThrow();
    expect(() => UsageSummaryInputSchema.parse({ days: 366 })).toThrow();
  });
});
