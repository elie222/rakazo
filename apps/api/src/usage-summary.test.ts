import { describe, expect, it } from "vitest";
import type { UsageSumCount } from "./usage-summary.js";
import { usageTotals, usageTotalsFromRows } from "./usage-summary.js";

const aggregate = (
  sums: UsageSumCount["_sum"],
  counts: UsageSumCount["_count"],
): UsageSumCount => ({ _sum: sums, _count: counts });

describe("usageTotals", () => {
  it("sums the calls that report a figure and flags the ones that do not", () => {
    const totals = usageTotals(
      aggregate(
        { inputTokens: 110, outputTokens: 30, totalTokens: 140, costUsd: 0.001 },
        { _all: 3, inputTokens: 3, outputTokens: 3, totalTokens: 2, costUsd: 2 },
      ),
      aggregate(
        { inputTokens: 110, outputTokens: 30, totalTokens: 140, costUsd: 0.001 },
        { _all: 3, inputTokens: 3, outputTokens: 3, totalTokens: 2, costUsd: 2 },
      ),
    );
    expect(totals).toEqual({
      inputTokens: 110,
      outputTokens: 30,
      totalTokens: 140,
      costUsd: 0.001,
      modelCalls: 3,
      unknownTokensCalls: 1,
      unknownCostCalls: 1,
    });
  });

  it("reads a figure as unknown only when no counted call reports it", () => {
    const totals = usageTotals(
      aggregate(
        { inputTokens: 10, outputTokens: 2, totalTokens: 12, costUsd: null },
        { _all: 2, inputTokens: 2, outputTokens: 2, totalTokens: 2, costUsd: 0 },
      ),
      aggregate(
        { inputTokens: 10, outputTokens: 2, totalTokens: 12, costUsd: null },
        { _all: 2, inputTokens: 2, outputTokens: 2, totalTokens: 2, costUsd: 0 },
      ),
    );
    expect(totals.totalTokens).toBe(12);
    expect(totals.costUsd).toBeNull();
    expect(totals.unknownCostCalls).toBe(2);
  });

  it("does not count transcription calls as unknown usage", () => {
    const totals = usageTotals(
      aggregate(
        { inputTokens: 10, outputTokens: 2, totalTokens: 12, costUsd: null },
        { _all: 3, inputTokens: 1, outputTokens: 1, totalTokens: 1, costUsd: 0 },
      ),
      aggregate(
        { inputTokens: 10, outputTokens: 2, totalTokens: 12, costUsd: null },
        { _all: 1, inputTokens: 1, outputTokens: 1, totalTokens: 1, costUsd: 0 },
      ),
    );
    expect(totals).toMatchObject({
      totalTokens: 12,
      costUsd: null,
      modelCalls: 3,
      unknownTokensCalls: 0,
      unknownCostCalls: 1,
    });
  });

  it("reports an empty group as unknown, not zero", () => {
    const empty = aggregate(
      { inputTokens: null, outputTokens: null, totalTokens: null, costUsd: null },
      { _all: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 },
    );
    expect(usageTotals(empty, empty)).toEqual({
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      costUsd: null,
      modelCalls: 0,
      unknownTokensCalls: 0,
      unknownCostCalls: 0,
    });
  });
});

describe("usageTotalsFromRows", () => {
  it("reconciles with the detail rows, excluding transcription calls from unknown counts", () => {
    const totals = usageTotalsFromRows([
      {
        inputTokens: 60,
        outputTokens: 30,
        totalTokens: 130,
        costUsd: 0.00012,
        operationKind: "answer",
      },
      {
        inputTokens: null,
        outputTokens: null,
        totalTokens: null,
        costUsd: null,
        operationKind: "answer",
      },
      {
        inputTokens: null,
        outputTokens: null,
        totalTokens: null,
        costUsd: null,
        operationKind: "transcription",
      },
    ]);
    expect(totals).toEqual({
      inputTokens: 60,
      outputTokens: 30,
      totalTokens: 130,
      costUsd: 0.00012,
      modelCalls: 3,
      unknownTokensCalls: 1,
      unknownCostCalls: 1,
    });
  });
});
