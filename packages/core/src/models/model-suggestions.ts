/**
 * Ranking for the model picker's "Suggested" section.
 *
 * Only models the space can already run are ranked. Recent use (and recent
 * success) lifts a model; a model whose last attempts all failed is treated as
 * exhausted and dropped, so the section re-ranks by itself as providers fail
 * and recover. Pure and deterministic, so it is unit-tested directly.
 */

import { canonicalPiProviderId } from "@rakazo/contracts";

export type ModelSuggestionReason = "recent";

/** How far back "recently used" reaches for the picker's suggestions. */
export const SUGGESTION_WINDOW_DAYS = 14;

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
  /** A use older than this no longer counts as recent. Defaults to SUGGESTION_WINDOW_DAYS. */
  windowDays?: number;
};

/**
 * One ranked row. Matches the wire `ModelSuggestion` shape in contracts; `score`
 * is only for sorting and is stripped before the value leaves this module.
 */
export type RankedModelSuggestion = ModelSuggestionCandidate & {
  reason: ModelSuggestionReason;
  recentRuns: number;
  successRatePct: number;
  lastUsedAt: string | null;
};

const DAY_MS = 86_400_000;
const FAILURE_WINDOW_MS = 60 * 60_000;
const MIN_FAILURES_TO_EXHAUST = 2;

const usageKey = (provider: string, modelId: string) =>
  `${canonicalPiProviderId(provider)}\0${modelId.trim().toLowerCase()}`;

function time(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Top recently used models for the picker. Candidates must already be runnable;
 * unused catalog rows are omitted. Score blends recency, volume, and success;
 * ties go to catalog recommendations and then stable label order.
 */
export function rankModelSuggestions(
  candidates: readonly ModelSuggestionCandidate[],
  usage: readonly ModelSuggestionUsage[],
  options: RankModelSuggestionsOptions = {},
): RankedModelSuggestion[] {
  const now = options.now ?? Date.now();
  const limit = Math.max(1, options.limit ?? 3);
  const windowDays = options.windowDays ?? SUGGESTION_WINDOW_DAYS;

  const usageByKey = new Map<string, ModelSuggestionUsage>();
  for (const entry of usage) {
    const id = usageKey(entry.provider, entry.modelId);
    const current = usageByKey.get(id);
    if (!current) {
      usageByKey.set(id, {
        ...entry,
        provider: canonicalPiProviderId(entry.provider),
        modelId: entry.modelId.trim(),
      });
      continue;
    }
    const lastUsed = time(entry.lastUsedAt);
    const currentUsed = time(current.lastUsedAt);
    usageByKey.set(id, {
      ...current,
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
  const scored: Array<RankedModelSuggestion & { score: number }> = [];
  for (const candidate of candidates) {
    if (!candidate.provider || !candidate.modelId) continue;
    const provider = canonicalPiProviderId(candidate.provider);
    const modelId = candidate.modelId.trim();
    const id = usageKey(provider, modelId);
    if (seen.has(id)) continue;
    seen.add(id);

    const use = usageByKey.get(id);
    const lastUsed = time(use?.lastUsedAt);
    const ageDays = lastUsed === null ? Infinity : Math.max(0, (now - lastUsed) / DAY_MS);
    const recent = ageDays <= windowDays;
    const lastFailed = time(use?.lastFailedAt);

    // Exhausted when the latest outcomes in the failure window are failures —
    // nothing has succeeded since those failures, regardless of older history.
    const exhausted =
      Boolean(use) &&
      use!.failures >= MIN_FAILURES_TO_EXHAUST &&
      lastFailed !== null &&
      now - lastFailed <= FAILURE_WINDOW_MS &&
      (lastUsed === null || lastFailed >= lastUsed);
    if (exhausted) continue;
    // Suggested is only for models the member actually used recently; unused
    // catalog rows stay in their provider groups instead of filling this shortcut.
    if (!recent || !use) continue;

    const attempts = use.successes + use.failures;
    const successRate = attempts > 0 ? use.successes / attempts : 0;
    const usageScore =
      100 *
      (0.55 * (1 - ageDays / windowDays) +
        0.3 * (Math.log1p(use.runs) / Math.log1p(Math.max(1, maxRuns))) +
        0.15 * successRate);

    scored.push({
      provider,
      modelId,
      label: candidate.label,
      providerName: candidate.providerName,
      recommended: candidate.recommended,
      reason: "recent",
      score: Math.round((50 + 0.5 * usageScore) * 10) / 10,
      recentRuns: use.runs,
      successRatePct: Math.round(successRate * 1000) / 10,
      lastUsedAt: use.lastUsedAt ?? null,
    });
  }

  scored.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    if (Boolean(right.recommended) !== Boolean(left.recommended)) {
      return right.recommended ? 1 : -1;
    }
    return left.label.localeCompare(right.label);
  });

  return scored.slice(0, limit).map(({ score: _score, recommended: _recommended, ...row }) => row);
}
