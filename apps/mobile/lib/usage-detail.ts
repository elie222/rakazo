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
 * Seven calendar days ending today, oldest first, from the summary's daily series.
 * Days with no rows read as 0 instead of disappearing, so the bars stay comparable.
 */
export function last7DaysUsage(
  daily: UsageSummary["daily"],
  today: Date,
  todayLabel: string,
): UsageDayPoint[] {
  const byDate = new Map<string, { tokens: number; calls: number }>();
  for (const day of daily ?? []) {
    byDate.set(day.date, {
      tokens: day.totalTokens ?? (day.inputTokens ?? 0) + (day.outputTokens ?? 0),
      calls: day.modelCalls ?? 0,
    });
  }
  const points: UsageDayPoint[] = [];
  for (let offset = 6; offset >= 0; offset -= 1) {
    const date = new Date(today);
    date.setDate(date.getDate() - offset);
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(
      date.getDate(),
    ).padStart(2, "0")}`;
    const day = byDate.get(key);
    points.push({
      date: key,
      label: offset === 0 ? todayLabel : `${date.getMonth() + 1}/${date.getDate()}`,
      tokens: day?.tokens ?? 0,
      calls: day?.calls ?? 0,
      isToday: offset === 0,
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

/** Records for the detail list, newest first, optionally only from today. */
export function usageDetailRecords(
  records: UsageRecord[],
  todayOnly: boolean,
  today: Date,
): UsageRecord[] {
  if (!todayOnly) return [...records];
  const key = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(
    today.getDate(),
  ).padStart(2, "0")}`;
  return records.filter((record) => record.createdAt.slice(0, 10) === key);
}
