/**
 * Shared usage-summary math. A total is the sum of the counted calls that
 * report that figure, and null only when no counted call reports it — one
 * call without a figure must not turn the whole total unknown. The unknown
 * counts say how many token-counted calls are missing that figure, so the
 * gap stays visible instead of being silently swallowed. Transcription calls
 * have no tokens by design, so they never count as unknown usage.
 */

export interface UsageSumCount {
  _sum: {
    inputTokens: number | null;
    outputTokens: number | null;
    totalTokens: number | null;
    costUsd: number | null;
  };
  _count: {
    _all: number;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    costUsd: number;
  };
}

export interface UsageTotals {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  costUsd: number | null;
  modelCalls: number;
  unknownTokensCalls: number;
  unknownCostCalls: number;
}

export interface UsageRowLike {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  costUsd: number | null;
  operationKind: string | null;
}

type TotalField = "inputTokens" | "outputTokens" | "totalTokens" | "costUsd";

/**
 * Combine one group's aggregate with the same aggregate restricted to
 * token-counted calls (everything except transcription). Totals come from all
 * calls; the unknown counts come from the restricted one.
 */
export function usageTotals(group: UsageSumCount, counted: UsageSumCount): UsageTotals {
  const total = (field: TotalField) => (group._count[field] > 0 ? (group._sum[field] ?? 0) : null);
  return {
    inputTokens: total("inputTokens"),
    outputTokens: total("outputTokens"),
    totalTokens: total("totalTokens"),
    costUsd: total("costUsd"),
    modelCalls: group._count._all,
    unknownTokensCalls: counted._count._all - counted._count.totalTokens,
    unknownCostCalls: counted._count._all - counted._count.costUsd,
  };
}

/** The same math over raw rows, for the daily series. */
export function usageTotalsFromRows(rows: readonly UsageRowLike[]): UsageTotals {
  const sums: Record<TotalField, number> = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    costUsd: 0,
  };
  const known: Record<TotalField, number> = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    costUsd: 0,
  };
  let countedAll = 0;
  let countedTokens = 0;
  let countedCost = 0;
  for (const row of rows) {
    const counted = row.operationKind !== "transcription";
    if (counted) {
      countedAll += 1;
      if (row.totalTokens !== null) countedTokens += 1;
      if (row.costUsd !== null) countedCost += 1;
    }
    for (const field of ["inputTokens", "outputTokens", "totalTokens", "costUsd"] as const) {
      const value = row[field];
      if (value !== null) {
        sums[field] += value;
        known[field] += 1;
      }
    }
  }
  const total = (field: TotalField) => (known[field] > 0 ? sums[field] : null);
  return {
    inputTokens: total("inputTokens"),
    outputTokens: total("outputTokens"),
    totalTokens: total("totalTokens"),
    costUsd: total("costUsd"),
    modelCalls: rows.length,
    unknownTokensCalls: countedAll - countedTokens,
    unknownCostCalls: countedAll - countedCost,
  };
}
