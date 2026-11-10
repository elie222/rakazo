import type { UsageRecord, UsageSummary } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import {
  compactTokenCount,
  groupUsageModels,
  isFailedUsageRecord,
  last7DaysUsage,
  localDateKey,
  localDayModelRows,
  localDayTotals,
  recordLocalDateKey,
  summarizeUsageRows,
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

/** ISO timestamp for a local date/time, so expectations hold in any runner timezone. */
function localIso(day: number, hour: number, minute = 0): string {
  return new Date(2026, 10, day, hour, minute).toISOString();
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

describe("recordLocalDateKey", () => {
  it("reads the record's local calendar day, not its UTC date", () => {
    expect(localDateKey(new Date(2026, 10, 10, 12, 0))).toBe("2026-11-10");
    // 00:30 local is the previous UTC day east of UTC; the key is the local day either way.
    expect(recordLocalDateKey(record({ createdAt: localIso(10, 0, 30) }))).toBe("2026-11-10");
    expect(recordLocalDateKey(record({ createdAt: localIso(9, 23, 30) }))).toBe("2026-11-09");
  });
});

describe("summarizeUsageRows", () => {
  it("sums reported figures, keeps unknown ones null, and never counts transcription as unknown", () => {
    const rows = [
      record({ inputTokens: 100, outputTokens: 20, totalTokens: 120, costUsd: 0.01 }),
      record({
        id: "rec-2",
        inputTokens: null,
        outputTokens: null,
        totalTokens: null,
        costUsd: null,
      }),
      record({
        id: "rec-3",
        operationKind: "transcription",
        inputTokens: null,
        outputTokens: null,
        totalTokens: null,
        costUsd: null,
      }),
    ];
    expect(summarizeUsageRows(rows)).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
      costUsd: 0.01,
      modelCalls: 3,
      unknownTokensCalls: 1,
      unknownCostCalls: 1,
    });
  });
});

describe("localDayTotals", () => {
  it("sums one local day and counts distinct runs", () => {
    const rows = [
      record({
        id: "a",
        createdAt: localIso(10, 0, 30),
        runId: "run-1",
        parentRunId: null,
        inputTokens: 100,
        outputTokens: 20,
        totalTokens: 120,
      }),
      record({
        id: "b",
        createdAt: localIso(10, 1),
        runId: "run-1",
        parentRunId: "run-1",
        inputTokens: 50,
        outputTokens: 10,
        totalTokens: 60,
      }),
      record({
        id: "c",
        createdAt: localIso(10, 2),
        runId: "run-2",
        parentRunId: null,
        inputTokens: null,
        outputTokens: null,
        totalTokens: null,
      }),
      record({ id: "d", createdAt: localIso(9, 23, 30) }),
    ];
    expect(localDayTotals(rows, new Date(2026, 10, 10, 12, 0))).toEqual({
      runs: 2,
      inputTokens: 150,
      outputTokens: 30,
      totalTokens: 180,
    });
  });

  it("keeps totals null when no record in the day reports them", () => {
    const rows = [
      record({
        id: "a",
        createdAt: localIso(10, 0, 30),
        inputTokens: null,
        outputTokens: null,
        totalTokens: null,
      }),
    ];
    expect(localDayTotals(rows, new Date(2026, 10, 10, 12, 0))).toEqual({
      runs: 1,
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
    });
  });
});

describe("localDayModelRows", () => {
  it("groups one local day by provider and model", () => {
    const rows = [
      record({
        id: "a",
        createdAt: localIso(10, 0, 30),
        inputTokens: 100,
        outputTokens: 20,
        totalTokens: 120,
      }),
      record({
        id: "b",
        createdAt: localIso(10, 1),
        inputTokens: 50,
        outputTokens: 10,
        totalTokens: null,
      }),
      record({
        id: "c",
        createdAt: localIso(10, 2),
        provider: "other",
        model: "whisper-large-v3",
        inputTokens: 10,
        outputTokens: 0,
        totalTokens: 10,
      }),
      record({ id: "d", createdAt: localIso(9, 23, 30) }),
    ];
    const groups = localDayModelRows(rows, new Date(2026, 10, 10, 12, 0));
    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({
      provider: "krisphyn",
      model: "Kimi K2.6",
      inputTokens: 150,
      outputTokens: 30,
      totalTokens: 120,
      modelCalls: 2,
      unknownTokensCalls: 1,
    });
    expect(groups[1]).toMatchObject({
      provider: "other",
      model: "whisper-large-v3",
      totalTokens: 10,
      modelCalls: 1,
    });
  });
});

describe("last7DaysUsage", () => {
  it("fills days without rows with zero, takes past days from the daily series, and today from the records", () => {
    const today = new Date(2026, 10, 10, 2, 8);
    const points = last7DaysUsage(
      [
        {
          date: "2026-11-08",
          inputTokens: 50,
          outputTokens: 0,
          totalTokens: 50,
          costUsd: null,
          modelCalls: 1,
          unknownTokensCalls: 0,
          unknownCostCalls: 0,
        },
      ],
      today,
      "Today",
      [
        record({
          id: "t1",
          createdAt: localIso(10, 0, 30),
          inputTokens: 80,
          outputTokens: 20,
          totalTokens: 100,
        }),
        record({
          id: "t2",
          createdAt: localIso(10, 1),
          inputTokens: 10,
          outputTokens: 0,
          totalTokens: null,
        }),
        record({ id: "t3", createdAt: localIso(9, 23, 30) }),
      ],
    );
    expect(points).toHaveLength(7);
    expect(points[0]).toMatchObject({ date: "2026-11-04", tokens: 0, isToday: false });
    expect(points[4]).toMatchObject({ date: "2026-11-08", tokens: 50, calls: 1 });
    expect(points[6]).toMatchObject({
      date: "2026-11-10",
      tokens: 100,
      calls: 2,
      label: "Today",
      isToday: true,
    });
    expect(points[5]?.label).toBe("11/9");
  });

  it("reads today from the records even when the daily series has a row for today", () => {
    const today = new Date(2026, 10, 10, 2, 8);
    const points = last7DaysUsage(
      [
        {
          date: "2026-11-10",
          inputTokens: 800,
          outputTokens: 199,
          totalTokens: 999,
          costUsd: null,
          modelCalls: 9,
          unknownTokensCalls: 0,
          unknownCostCalls: 0,
        },
      ],
      today,
      "Today",
      [],
    );
    expect(points[6]).toMatchObject({ date: "2026-11-10", tokens: 0, calls: 0, isToday: true });
  });

  it("falls back to input plus output for today when no record reports a total", () => {
    const today = new Date(2026, 10, 10, 2, 8);
    const points = last7DaysUsage([], today, "Today", [
      record({
        id: "t1",
        createdAt: localIso(10, 0, 30),
        inputTokens: 40,
        outputTokens: 10,
        totalTokens: null,
      }),
      record({
        id: "t2",
        createdAt: localIso(10, 1),
        inputTokens: 30,
        outputTokens: 0,
        totalTokens: null,
      }),
    ]);
    expect(points[6]).toMatchObject({ tokens: 80, calls: 2 });
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
          unknownTokensCalls: 0,
          unknownCostCalls: 0,
        },
        {
          provider: "krisphyn",
          model: "whisper-large-v3",
          inputTokens: 10,
          outputTokens: 0,
          totalTokens: 10,
          costUsd: null,
          modelCalls: 1,
          unknownTokensCalls: 0,
          unknownCostCalls: 0,
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
            unknownTokensCalls: 0,
            unknownCostCalls: 0,
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
  it("keeps only today's records when asked, by local day", () => {
    const rows = [
      record({ id: "early", createdAt: localIso(10, 0, 30) }),
      record({ id: "morning", createdAt: localIso(10, 7, 4) }),
      record({ id: "last-night", createdAt: localIso(9, 23, 30) }),
    ];
    expect(
      usageDetailRecords(rows, true, new Date(2026, 10, 10, 12, 0)).map((row) => row.id),
    ).toEqual(["early", "morning"]);
    expect(usageDetailRecords(rows, false, new Date(2026, 10, 10, 12, 0))).toHaveLength(3);
  });
});
