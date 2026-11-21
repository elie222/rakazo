import type { ModelCatalogEntry } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it } from "vitest";
import { buildModelSuggestions, SUGGESTION_WINDOW_DAYS } from "./model-suggestions.js";

const NOW = Date.parse("2026-11-21T12:00:00.000Z");
const hoursAgo = (hours: number) => new Date(NOW - hours * 3_600_000);

const catalog: ModelCatalogEntry[] = [
  { provider: "anthropic", id: "claude-opus-5", label: "Claude Opus 5", billing: "subscription" },
  { provider: "deepseek", id: "deepseek-v4-pro", label: "DeepSeek V4 Pro", billing: "api" },
  { provider: "openai", id: "gpt-6", label: "GPT-6", billing: "api", recommended: true },
];

function stubPrisma(rows: unknown[]): PrismaClient {
  return { run: { groupBy: async () => rows } } as unknown as PrismaClient;
}

function row(
  modelProvider: string,
  modelId: string,
  status: string,
  count: number,
  createdAt: Date,
) {
  return { modelProvider, modelId, status, _count: { _all: count }, _max: { createdAt } };
}

describe("buildModelSuggestions", () => {
  it("ranks the model the member actually runs first", async () => {
    const prisma = stubPrisma([
      row("deepseek", "deepseek-v4-pro", "completed", 20, hoursAgo(1)),
      row("deepseek", "deepseek-v4-pro", "failed", 1, hoursAgo(3)),
    ]);

    const suggestions = await buildModelSuggestions(prisma, "user-1", catalog, NOW);

    expect(suggestions.map((entry) => entry.modelId)).toEqual([
      "deepseek-v4-pro",
      "gpt-6",
      "claude-opus-5",
    ]);
    expect(suggestions[0]).toMatchObject({
      reason: "recent",
      recentRuns: 21,
      successRatePct: 95.2,
    });
  });

  it("drops a model whose last attempts all failed", async () => {
    const prisma = stubPrisma([
      row("deepseek", "deepseek-v4-pro", "failed", 3, hoursAgo(0.5)),
      row("deepseek", "deepseek-v4-pro", "cancelled", 1, hoursAgo(4)),
    ]);

    const suggestions = await buildModelSuggestions(prisma, "user-1", catalog, NOW);

    expect(suggestions.some((entry) => entry.modelId === "deepseek-v4-pro")).toBe(false);
    expect(suggestions).toHaveLength(2);
  });

  it("never suggests a placeholder catalog row", async () => {
    const prisma = stubPrisma([]);
    const withPlaceholder: ModelCatalogEntry[] = [
      ...catalog,
      {
        provider: "openai-compatible",
        id: "",
        label: "Add a key",
        billing: "api",
        placeholder: true,
      },
    ];

    const suggestions = await buildModelSuggestions(prisma, "user-1", withPlaceholder, NOW);

    expect(suggestions.every((entry) => entry.label !== "Add a key")).toBe(true);
  });

  it("returns at most three rows", async () => {
    const suggestions = await buildModelSuggestions(stubPrisma([]), "user-1", catalog, NOW);
    expect(suggestions).toHaveLength(3);
  });

  it("only reads runs inside the recent window", async () => {
    let captured: { createdAt?: { gte?: Date } } | undefined;
    const prisma = {
      run: {
        groupBy: async (args: { where: { createdAt: { gte: Date } } }) => {
          captured = args.where;
          return [];
        },
      },
    } as unknown as PrismaClient;

    await buildModelSuggestions(prisma, "user-1", catalog, NOW);

    expect(captured?.createdAt?.gte?.toISOString()).toBe(
      new Date(NOW - SUGGESTION_WINDOW_DAYS * 86_400_000).toISOString(),
    );
  });
});
