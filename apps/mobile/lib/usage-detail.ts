import type { UsageRecord, UsageSummary } from "@rakazo/contracts";

/** A call that never ran or was refused: it counts as 0 and never joins the totals. */
export function isFailedUsageRecord(record: UsageRecord): boolean {
  if (record.usageSource === "provider-rejected" || record.usageSource === "not-started")
    return true;
  const input = record.inputTokens ?? 0;
  const output = record.outputTokens ?? 0;
  const total = record.totalTokens ?? input + output;
  return input === 0 && output === 0 && total === 0;
}

export function usageRecordTokens(record: UsageRecord): {
  input: number;
  output: number;
  total: number;
} {
  const input = record.inputTokens ?? 0;
  const output = record.outputTokens ?? 0;
  return { input, output, total: record.totalTokens ?? input + output };
}

/** Local calendar day key (YYYY-MM-DD) for a date in the device's timezone. */
export function localDateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(
    date.getDate(),
  ).padStart(2, "0")}`;
}

/** The local calendar day a record belongs to. createdAt is an ISO UTC string. */
export function recordLocalDateKey(record: UsageRecord): string {
  const date = new Date(record.createdAt);
  if (Number.isNaN(date.getTime())) return record.createdAt.slice(0, 10);
  return localDateKey(date);
}

/**
 * The same totals math as the server's usageTotalsFromRows, over raw rows:
 * a figure is the sum of the rows that report it, null only when no row
 * reports it. Transcription rows carry no tokens by design, so they never
 * count as unknown usage.
 */
export function summarizeUsageRows(rows: readonly UsageRecord[]): {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  costUsd: number | null;
  modelCalls: number;
  unknownTokensCalls: number;
  unknownCostCalls: number;
} {
  const sums = { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 };
  const known = { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 };
  let countedAll = 0;
  let countedTokens = 0;
  let countedCost = 0;
  for (const row of rows) {
    const counted = row.operationKind !== "transcription";
    if (counted) {
      countedAll += 1;
      if (row.totalTokens != null) countedTokens += 1;
      if (row.costUsd != null) countedCost += 1;
    }
    for (const field of ["inputTokens", "outputTokens", "totalTokens", "costUsd"] as const) {
      const value = row[field];
      if (value != null) {
        sums[field] += value;
        known[field] += 1;
      }
    }
  }
  const total = (field: keyof typeof sums) => (known[field] > 0 ? sums[field] : null);
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

/**
 * Totals for one local calendar day, summed from the records themselves —
 * the same shape usageRangeTotals returns, so the summary card reads it
 * unchanged. Runs count distinct runs, mirroring the server.
 */
export function localDayTotals(
  records: UsageRecord[],
  day: Date,
): ReturnType<typeof usageRangeTotals> {
  const rows = usageDetailRecords(records, true, day);
  const totals = summarizeUsageRows(rows);
  const runs = new Set(rows.map((row) => row.parentRunId ?? row.runId).filter(Boolean)).size;
  return {
    runs,
    inputTokens: totals.inputTokens,
    outputTokens: totals.outputTokens,
    totalTokens: totals.totalTokens,
  };
}

/** Per-model rows for one local calendar day, in the summary's models shape. */
export function localDayModelRows(
  records: UsageRecord[],
  day: Date,
): NonNullable<UsageSummary["models"]> {
  const rows = usageDetailRecords(records, true, day);
  const byKey = new Map<string, { provider: string; model: string; rows: UsageRecord[] }>();
  for (const row of rows) {
    const key = `${row.provider}:${row.model}`;
    const group = byKey.get(key) ?? { provider: row.provider, model: row.model, rows: [] };
    group.rows.push(row);
    byKey.set(key, group);
  }
  return [...byKey.values()].map(({ provider, model, rows: groupRows }) => ({
    provider,
    model,
    ...summarizeUsageRows(groupRows),
  }));
}

/** Totals for one range card; null stays null so the screen can show "—". */
export function usageRangeTotals(summary: UsageSummary | null): {
  runs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
} {
  return {
    runs: summary?.runs ?? 0,
    inputTokens: summary?.inputTokens ?? null,
    outputTokens: summary?.outputTokens ?? null,
    totalTokens: summary?.totalTokens ?? null,
  };
}

export type UsageDayPoint = {
  date: string;
  label: string;
  tokens: number;
  calls: number;
  isToday: boolean;
};

/**
 * Seven calendar days ending today, oldest first. Past days come from the
 * server's daily series (grouped by UTC day, so each bar is a 24h window
 * shifted by the timezone offset); today is summed from the records in
 * local time, so the bar lines up with the today card and the detail list.
 * The server list only holds the latest 100 records, so past days cannot be
 * re-split from records — that needs a server-side local-day series.
 */
export function last7DaysUsage(
  daily: UsageSummary["daily"],
  today: Date,
  todayLabel: string,
  records: UsageRecord[],
): UsageDayPoint[] {
  const byDate = new Map<string, { tokens: number; calls: number }>();
  for (const day of daily ?? []) {
    byDate.set(day.date, {
      tokens: day.totalTokens ?? (day.inputTokens ?? 0) + (day.outputTokens ?? 0),
      calls: day.modelCalls ?? 0,
    });
  }
  const todayTotals = summarizeUsageRows(usageDetailRecords(records, true, today));
  const todayTokens =
    todayTotals.totalTokens ?? (todayTotals.inputTokens ?? 0) + (todayTotals.outputTokens ?? 0);
  const points: UsageDayPoint[] = [];
  for (let offset = 6; offset >= 0; offset -= 1) {
    const date = new Date(today);
    date.setDate(date.getDate() - offset);
    const key = localDateKey(date);
    if (offset === 0) {
      points.push({
        date: key,
        label: todayLabel,
        tokens: todayTokens,
        calls: todayTotals.modelCalls,
        isToday: true,
      });
      continue;
    }
    const day = byDate.get(key);
    points.push({
      date: key,
      label: `${date.getMonth() + 1}/${date.getDate()}`,
      tokens: day?.tokens ?? 0,
      calls: day?.calls ?? 0,
      isToday: false,
    });
  }
  return points;
}

/** Bar labels stay short: 12.6万 above ten thousand, grouped digits below. */
export function compactTokenCount(value: number): string {
  if (value >= 10_000) {
    const wan = value / 10_000;
    return `${wan >= 100 ? Math.round(wan) : wan.toFixed(1).replace(/\.0$/, "")}万`;
  }
  return new Intl.NumberFormat("en-US").format(value);
}

const VOICE_MODEL = /whisper|transcri|stt|tts|speech|audio|voice/i;

export type UsageModelRole = "voice" | "chat";

export type UsageModelGroup = {
  key: string;
  provider: string;
  model: string;
  role: UsageModelRole;
  calls: number;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  share: number | null;
  recent: { id: string; label: string; tokens: number; failed: boolean }[];
};

/**
 * One card per model, biggest first. The contract carries no main/computer/voice
 * role, so only a speech-named model reads as voice; the rest show their provider.
 */
export function groupUsageModels(
  models: UsageSummary["models"],
  records: UsageRecord[],
  grandTotalTokens: number | null,
): UsageModelGroup[] {
  const rows = [...(models ?? [])].sort(
    (a, b) => (b.totalTokens ?? 0) - (a.totalTokens ?? 0) || b.modelCalls - a.modelCalls,
  );
  return rows.map((row) => {
    const total = row.totalTokens ?? (row.inputTokens ?? 0) + (row.outputTokens ?? 0);
    const recent = records
      .filter((record) => record.provider === row.provider && record.model === row.model)
      .slice(0, 3)
      .map((record) => ({
        id: record.id,
        label: record.createdAt,
        tokens: usageRecordTokens(record).total,
        failed: isFailedUsageRecord(record),
      }));
    return {
      key: `${row.provider}:${row.model}`,
      provider: row.provider,
      model: row.model,
      role: VOICE_MODEL.test(row.model) ? "voice" : "chat",
      calls: row.modelCalls,
      inputTokens: row.inputTokens ?? null,
      outputTokens: row.outputTokens ?? null,
      totalTokens: row.totalTokens ?? null,
      share: grandTotalTokens !== null && grandTotalTokens > 0 ? total / grandTotalTokens : null,
      recent,
    };
  });
}

/** Records for the detail list, newest first, optionally only from today (local day). */
export function usageDetailRecords(
  records: UsageRecord[],
  todayOnly: boolean,
  today: Date,
): UsageRecord[] {
  if (!todayOnly) return [...records];
  const key = localDateKey(today);
  return records.filter((record) => recordLocalDateKey(record) === key);
}
