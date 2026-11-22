/**
 * Suggested models for a member's Space: the models that Space can run now,
 * ranked by that member's own recent runs in that Space. Nothing is stored —
 * the score is derived from the existing `runs` table on each read.
 */

import type { ModelCatalogEntry, ModelCredential, ModelSuggestion } from "@rakazo/contracts";
import { canonicalPiProviderId } from "@rakazo/contracts";
import type { ModelSuggestionUsage } from "@rakazo/core";
import {
  connectedModelChoices,
  rankModelSuggestions,
  SUGGESTION_WINDOW_DAYS,
} from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";

export { SUGGESTION_WINDOW_DAYS };

const DAY_MS = 86_400_000;

type RunHistoryRow = {
  modelProvider: string | null;
  modelId: string | null;
  status: string;
  completedAt: Date | null;
};

/**
 * Aggregate finished runs into the usage shape the ranker consumes. Only rows
 * with a real provider/model and a completion time count; in-flight and
 * cancelled runs do not.
 */
export function usageFromRuns(
  rows: readonly RunHistoryRow[],
): ModelSuggestionUsage[] {
  const byKey = new Map<
    string,
    {
      provider: string;
      modelId: string;
      runs: number;
      successes: number;
      failures: number;
      lastUsedAt: number | null;
      lastFailedAt: number | null;
    }
  >();

  for (const row of rows) {
    const provider = row.modelProvider?.trim();
    const modelId = row.modelId?.trim();
    if (!provider || !modelId || !row.completedAt) continue;
    if (row.status !== "completed" && row.status !== "failed") continue;

    const key = `${canonicalPiProviderId(provider)}\0${modelId.toLowerCase()}`;
    const completedAt = row.completedAt.getTime();
    const current = byKey.get(key) ?? {
      provider: canonicalPiProviderId(provider),
      modelId,
      runs: 0,
      successes: 0,
      failures: 0,
      lastUsedAt: null as number | null,
      lastFailedAt: null as number | null,
    };
    current.runs += 1;
    if (row.status === "completed") {
      current.successes += 1;
      current.lastUsedAt =
        current.lastUsedAt === null ? completedAt : Math.max(current.lastUsedAt, completedAt);
    } else {
      current.failures += 1;
      current.lastFailedAt =
        current.lastFailedAt === null
          ? completedAt
          : Math.max(current.lastFailedAt, completedAt);
    }
    byKey.set(key, current);
  }

  return [...byKey.values()].map((entry) => ({
    provider: entry.provider,
    modelId: entry.modelId,
    runs: entry.runs,
    successes: entry.successes,
    failures: entry.failures,
    lastUsedAt: entry.lastUsedAt === null ? null : new Date(entry.lastUsedAt).toISOString(),
    lastFailedAt:
      entry.lastFailedAt === null ? null : new Date(entry.lastFailedAt).toISOString(),
  }));
}

/**
 * Top three models the Space can run now, scored from the member's finished
 * runs in that Space over the suggestion window.
 */
export async function buildModelSuggestions(
  prisma: PrismaClient,
  actor: { userId: string; spaceId: string },
  catalog: readonly ModelCatalogEntry[],
  credentials: readonly ModelCredential[],
  options: { now?: Date; limit?: number } = {},
): Promise<ModelSuggestion[]> {
  const now = options.now ?? new Date();
  const since = new Date(now.getTime() - SUGGESTION_WINDOW_DAYS * DAY_MS);

  const choices = connectedModelChoices(credentials, catalog);
  const recommendedByKey = new Map(
    catalog.map((entry) => [
      `${canonicalPiProviderId(entry.provider)}\0${entry.id.trim().toLowerCase()}`,
      Boolean(entry.recommended),
    ]),
  );
  const candidates = choices.map((choice) => ({
    provider: choice.provider,
    modelId: choice.modelId,
    label: choice.modelLabel ?? choice.label,
    providerName: choice.providerLabel,
    recommended:
      recommendedByKey.get(
        `${canonicalPiProviderId(choice.provider)}\0${choice.modelId.trim().toLowerCase()}`,
      ) ?? false,
  }));

  if (candidates.length === 0) return [];

  // Cap the scan so a heavy 14-day history cannot stall the picker. Newest
  // finished runs are enough for ranking and exhaustion; older ones matter less.
  const rows = await prisma.run.findMany({
    where: {
      userId: actor.userId,
      spaceId: actor.spaceId,
      // `gte` already excludes null completedAt; status/model filters keep only finished runs.
      completedAt: { gte: since },
      status: { in: ["completed", "failed"] },
      modelProvider: { not: null },
      modelId: { not: null },
    },
    orderBy: { completedAt: "desc" },
    take: 500,
    select: {
      modelProvider: true,
      modelId: true,
      status: true,
      completedAt: true,
    },
  });

  return rankModelSuggestions(candidates, usageFromRuns(rows), {
    now: now.getTime(),
    limit: options.limit,
    windowDays: SUGGESTION_WINDOW_DAYS,
  });
}
