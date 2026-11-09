import type { UsageRecord, UsageSummary } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import {
  compactTokenCount,
  groupUsageModels,
  isFailedUsageRecord,
  last7DaysUsage,
  usageDetailRecords,
  usageRangeTotals,
  usageRecordTokens,
} from "./usage-detail";

function record(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    id: "rec-1",
    botId: "bot-1",
    runId: "run-1",
    provider: "krisphyn",
    model: "Kimi K2.6",
    inputTokens: 100,
    outputTokens: 20,
    totalTokens: 120,
    createdAt: "2026-11-10T02:04:00.000Z",
    ...overrides,
  };
}

function summary(overrides: Partial<UsageSummary> = {}): UsageSummary {
  return {
    inputTokens: 100,
    outputTokens: 20,
    totalTokens: 120,
    runs: 1,
    ...overrides,
  };
}

describe("isFailedUsageRecord", () => {
  it("treats provider-rejected and not-started calls as failed", () => {
    expect(isFailedUsageRecord(record({ usageSource: "provider-rejected" }))).toBe(true);
    expect(isFailedUsageRecord(record({ usageSource: "not-started" }))).toBe(true);
    expect(isFailedUsageRecord(record({ usageSource: "response" }))).toBe(false);
  });

  it("treats a call with no counted tokens as failed", () => {
    expect(
      isFailedUsageRecord(record({ inputTokens: null, outputTokens: null, totalTokens: null })),
    ).toBe(true);
    expect(isFailedUsageRecord(record({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }))).toBe(
      true,
    );
    expect(isFailedUsageRecord(record({ inputTokens: 5, outputTokens: null }))).toBe(false);
  });
});

describe("usageRecordTokens", () => {
  it("falls back to input plus output when the total is missing", () => {
    expect(usageRecordTokens(record({ totalTokens: null }))).toEqual({
      input: 100,
      output: 20,
      total: 120,
    });
    expect(usageRecordTokens(record({ inputTokens: null, outputTokens: null }))).toEqual({
      input: 0,
      output: 0,
      total: 120,
    });
  });
});

describe("usageRangeTotals", () => {
  it("keeps unknown totals null instead of inventing a zero", () => {
    expect(usageRangeTotals(null)).toEqual({
      runs: 0,
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
    });
    expect(usageRangeTotals(summary({ totalTokens: null }))).toMatchObject({
      runs: 1,
      totalTokens: null,
    });
  });
});

describe("last7DaysUsage", () => {
  it("fills days without rows with zero and labels today", () => {
    const today = new Date(2026, 10, 10, 2, 8);
    const points = last7DaysUsage(
      [
        {
          date: "2026-11-10",
          inputTokens: 80,
          outputTokens: 20,
          totalTokens: 100,
          costUsd: null,
          modelCalls: 2,
        },
        {
          date: "2026-11-08",
          inputTokens: 50,
          outputTokens: 0,
          totalTokens: 50,
          costUsd: null,
          modelCalls: 1,
        },
      ],
      today,
      "Today",
    );
    expect(points).toHaveLength(7);
    expect(points[0]).toMatchObject({ date: "2026-11-04", tokens: 0, isToday: false });
    expect(points[4]).toMatchObject({ date: "2026-11-08", tokens: 50, calls: 1 });
    expect(points[6]).toMatchObject({
      date: "2026-11-10",
      tokens: 100,
      label: "Today",
      isToday: true,
    });
    expect(points[5]?.label).toBe("11/9");
  });
});

describe("compactTokenCount", () => {
  it("shortens ten-thousands and groups smaller counts", () => {
    expect(compactTokenCount(93855)).toBe("9.4万");
    expect(compactTokenCount(126000)).toBe("12.6万");
    expect(compactTokenCount(100000)).toBe("10万");
    expect(compactTokenCount(8306)).toBe("8,306");
  });
});

describe("groupUsageModels", () => {
  it("sorts by tokens, shares the grand total, and keeps recent calls per model", () => {
    const models = summary({
      models: [
        {
          provider: "krisphyn",
          model: "Kimi K2.6",
          inputTokens: 100,
          outputTokens: 20,
          totalTokens: 120,
          costUsd: null,
          modelCalls: 2,
        },
        {
          provider: "krisphyn",
          model: "whisper-large-v3",
          inputTokens: 10,
          outputTokens: 0,
          totalTokens: 10,
          costUsd: null,
          modelCalls: 1,
        },
      ],
    }).models;
    const groups = groupUsageModels(models, [record(), record({ id: "rec-2" })], 130);
    expect(groups).toHaveLength(2);
    const [first, second] = groups;
    expect(first).toMatchObject({
      key: "krisphyn:Kimi K2.6",
      role: "chat",
      calls: 2,
      totalTokens: 120,
    });
    expect(first?.share).toBeCloseTo(120 / 130);
    expect(first?.recent).toHaveLength(2);
    expect(second).toMatchObject({ role: "voice", totalTokens: 10 });
  });

  it("has no share when the grand total is unknown", () => {
    const groups = groupUsageModels(
      summary({
        models: [
          {
            provider: "krisphyn",
            model: "Kimi K2.6",
            inputTokens: null,
            outputTokens: null,
            totalTokens: null,
            costUsd: null,
            modelCalls: 1,
          },
        ],
      }).models,
      [],
      null,
    );
    expect(groups[0]?.share).toBeNull();
  });
});

describe("usageDetailRecords", () => {
  it("keeps only today's records when asked", () => {
    const rows = [
      record({ id: "today", createdAt: "2026-11-10T02:04:00.000Z" }),
      record({ id: "yesterday", createdAt: "2026-11-09T23:04:00.000Z" }),
    ];
    expect(
      usageDetailRecords(rows, true, new Date(2026, 10, 10, 12, 0)).map((row) => row.id),
    ).toEqual(["today"]);
    expect(usageDetailRecords(rows, false, new Date(2026, 10, 10, 12, 0))).toHaveLength(2);
  });
});
