import type { ModelCatalogEntry, ModelSuggestion } from "@rakazo/contracts";
import type { ModelSuggestionUsage } from "@rakazo/core";
import { rankModelSuggestions } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";

/** How far back "recently used" reaches for the picker's suggestions. */
export const SUGGESTION_WINDOW_DAYS = 14;

const DAY_MS = 86_400_000;

function newer(left: string | null | undefined, right: Date | null | undefined): string | null {
  const leftTime = left ? Date.parse(left) : NaN;
  const rightTime = right ? right.getTime() : NaN;
  if (!Number.isFinite(rightTime)) return left ?? null;
  if (!Number.isFinite(leftTime) || rightTime >= leftTime) return right!.toISOString();
  return left ?? null;
}

/**
 * Top models for a space's picker: every model it can already run, ranked by
 * recent runs. Reads the run history instead of storing a second health table,
 * so exhaustion follows real outcomes and needs no migration.
 */
export async function buildModelSuggestions(
  prisma: PrismaClient,
  userId: string,
  catalog: readonly ModelCatalogEntry[],
  now = Date.now(),
): Promise<ModelSuggestion[]> {
  const since = new Date(now - SUGGESTION_WINDOW_DAYS * DAY_MS);
  const rows = await prisma.run.groupBy({
    by: ["modelProvider", "modelId", "status"],
    where: {
      userId,
      createdAt: { gte: since },
      modelProvider: { not: null },
      modelId: { not: null },
    },
    _count: { _all: true },
    _max: { createdAt: true },
  });

  const usage = new Map<string, ModelSuggestionUsage>();
  for (const row of rows) {
    const provider = row.modelProvider;
    const modelId = row.modelId;
    if (!provider || !modelId) continue;
    const key = `${provider}\0${modelId}`;
    const current = usage.get(key) ?? {
      provider,
      modelId,
      runs: 0,
      successes: 0,
      failures: 0,
      lastUsedAt: null,
      lastFailedAt: null,
    };
    const count = row._count._all;
    current.runs += count;
    if (row.status === "completed") current.successes += count;
    if (row.status === "failed") current.failures += count;
    current.lastUsedAt = newer(current.lastUsedAt, row._max.createdAt);
    if (row.status === "failed")
      current.lastFailedAt = newer(current.lastFailedAt, row._max.createdAt);
    usage.set(key, current);
  }

  const candidates = catalog
    .filter((entry) => !entry.placeholder)
    .map((entry) => ({
      provider: entry.provider,
      modelId: entry.id,
      label: entry.label,
      providerName: entry.providerName,
      recommended: entry.recommended,
    }));

  return rankModelSuggestions(candidates, [...usage.values()], {
    now,
    windowDays: SUGGESTION_WINDOW_DAYS,
    limit: 3,
  });
}
