/**
 * Ranking for the model picker's "Suggested" section.
 *
 * Only models the space can already run are ranked. Recent use (and recent
 * success) lifts a model; a model whose last attempts all failed is treated as
 * exhausted and dropped, so the section re-ranks by itself as providers fail
 * and recover. Pure and deterministic, so it is unit-tested directly.
 */

export type ModelSuggestionReason = "recent" | "available";

export type ModelSuggestionCandidate = {
  provider: string;
  modelId: string;
  label: string;
  providerName?: string;
  recommended?: boolean;
};

export type ModelSuggestionUsage = {
  provider: string;
  modelId: string;
  runs: number;
  successes: number;
  failures: number;
  lastUsedAt: string | null;
  lastFailedAt?: string | null;
};

export type RankModelSuggestionsOptions = {
  limit?: number;
  now?: number;
  /** A use older than this no longer counts as recent. */
  windowDays?: number;
  /** Recent consecutive failures that make a model "exhausted" for this long. */
  failureWindowMinutes?: number;
  /** Ignore usage for these providers (e.g. a deployment fallback). */
  excludeProviders?: Iterable<string>;
};

export type ModelSuggestion = ModelSuggestionCandidate & {
  reason: ModelSuggestionReason;
  score: number;
  recentRuns: number;
  successRatePct: number;
  lastUsedAt: string | null;
};

const DAY_MS = 86_400_000;
const DEFAULT_WINDOW_DAYS = 14;
const DEFAULT_FAILURE_WINDOW_MINUTES = 60;
const MIN_FAILURES_TO_EXHAUST = 2;

const key = (provider: string, modelId: string) =>
  `${provider.trim().toLowerCase()}\0${modelId.trim().toLowerCase()}`;

function time(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Top models for the picker. Half the score is availability (every candidate
 * here is already runnable), half is real recent use; ties go to catalog
 * recommendations and then stable label order.
 */
export function rankModelSuggestions(
  candidates: readonly ModelSuggestionCandidate[],
  usage: readonly ModelSuggestionUsage[],
  options: RankModelSuggestionsOptions = {},
): ModelSuggestion[] {
  const now = options.now ?? Date.now();
  const limit = Math.max(1, options.limit ?? 3);
  const windowDays = options.windowDays ?? DEFAULT_WINDOW_DAYS;
  const failureWindowMs = (options.failureWindowMinutes ?? DEFAULT_FAILURE_WINDOW_MINUTES) * 60_000;
  const excluded = new Set(
    [...(options.excludeProviders ?? [])].map((provider) => provider.trim().toLowerCase()),
  );

  const usageByKey = new Map<string, ModelSuggestionUsage>();
  for (const entry of usage) {
    const id = key(entry.provider, entry.modelId);
    const current = usageByKey.get(id);
    if (!current) {
      usageByKey.set(id, entry);
      continue;
    }
    const lastUsed = time(entry.lastUsedAt);
    const currentUsed = time(current.lastUsedAt);
    usageByKey.set(id, {
      ...entry,
      runs: current.runs + entry.runs,
      successes: current.successes + entry.successes,
      failures: current.failures + entry.failures,
      lastUsedAt:
        lastUsed && currentUsed && currentUsed > lastUsed ? current.lastUsedAt : entry.lastUsedAt,
      lastFailedAt:
        (time(entry.lastFailedAt) ?? 0) >= (time(current.lastFailedAt) ?? 0)
          ? entry.lastFailedAt
          : current.lastFailedAt,
    });
  }

  const maxRuns = Math.max(1, ...[...usageByKey.values()].map((entry) => entry.runs));

  const seen = new Set<string>();
  const scored: ModelSuggestion[] = [];
  for (const candidate of candidates) {
    if (!candidate.provider || !candidate.modelId) continue;
    if (excluded.has(candidate.provider.trim().toLowerCase())) continue;
    const id = key(candidate.provider, candidate.modelId);
    if (seen.has(id)) continue;
    seen.add(id);

    const use = usageByKey.get(id);
    const lastUsed = time(use?.lastUsedAt);
    const ageDays = lastUsed === null ? Infinity : Math.max(0, (now - lastUsed) / DAY_MS);
    const recent = ageDays <= windowDays;
    const lastFailed = time(use?.lastFailedAt);

    // Exhausted: repeated recent failures with nothing working since.
    const exhausted =
      Boolean(use) &&
      use!.failures >= MIN_FAILURES_TO_EXHAUST &&
      lastFailed !== null &&
      now - lastFailed <= failureWindowMs &&
      use!.failures > use!.successes;
    if (exhausted) continue;

    const attempts = use ? use.successes + use.failures : 0;
    const successRate = attempts > 0 ? use!.successes / attempts : 0;
    const usageScore = recent
      ? 100 *
        (0.55 * (1 - ageDays / windowDays) +
          0.3 * (Math.log1p(use!.runs) / Math.log1p(Math.max(1, maxRuns))) +
          0.15 * successRate)
      : 0;

    scored.push({
      ...candidate,
      reason: recent ? "recent" : "available",
      score: Math.round((50 + 0.5 * usageScore) * 10) / 10,
      recentRuns: use?.runs ?? 0,
      successRatePct: Math.round(successRate * 1000) / 10,
      lastUsedAt: recent ? (use?.lastUsedAt ?? null) : null,
    });
  }

  scored.sort(
    (left, right) =>
      right.score - left.score ||
      Number(Boolean(right.recommended)) - Number(Boolean(left.recommended)) ||
      left.label.localeCompare(right.label),
  );
  return scored.slice(0, limit);
}
