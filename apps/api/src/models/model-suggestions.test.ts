import { describe, expect, it, vi } from "vitest";
import { buildModelSuggestions, usageFromRuns } from "./model-suggestions.js";

const NOW = new Date("2026-03-20T12:00:00.000Z");

function catalogEntry(
  provider: string,
  id: string,
  extras: {
    label?: string;
    providerName?: string;
    placeholder?: boolean;
    recommended?: boolean;
  } = {},
) {
  return {
    provider,
    id,
    label: extras.label ?? id,
    providerName: extras.providerName ?? provider,
    billing: "byok",
    ...(extras.placeholder ? { placeholder: true } : {}),
    ...(extras.recommended ? { recommended: true } : {}),
  } as const;
}

function credential(
  provider: string,
  extras: {
    id?: string;
    modelId?: string | null;
    enabledModelIds?: string[];
    preferenceRank?: number;
  } = {},
) {
  return {
    id: extras.id ?? `${provider}-cred`,
    provider,
    label: provider,
    hasKey: true,
    isDefault: false,
    ...(extras.modelId !== undefined && extras.modelId !== null ? { modelId: extras.modelId } : {}),
    ...(extras.enabledModelIds ? { enabledModelIds: extras.enabledModelIds } : {}),
    ...(extras.preferenceRank !== undefined ? { preferenceRank: extras.preferenceRank } : {}),
  };
}

describe("usageFromRuns", () => {
  it("counts completed and failed runs with last timestamps", () => {
    const usage = usageFromRuns([
      {
        modelProvider: "openai",
        modelId: "gpt-4.1",
        status: "completed",
        completedAt: new Date("2026-03-19T10:00:00.000Z"),
      },
      {
        modelProvider: "openai",
        modelId: "gpt-4.1",
        status: "failed",
        completedAt: new Date("2026-03-19T11:00:00.000Z"),
      },
      {
        modelProvider: "openai",
        modelId: "gpt-4.1",
        status: "completed",
        completedAt: new Date("2026-03-19T12:00:00.000Z"),
      },
      {
        modelProvider: "anthropic",
        modelId: null,
        status: "completed",
        completedAt: new Date("2026-03-19T12:00:00.000Z"),
      },
      {
        modelProvider: "openai",
        modelId: "o3",
        status: "cancelled",
        completedAt: new Date("2026-03-19T12:00:00.000Z"),
      },
    ]);

    expect(usage).toEqual([
      {
        provider: "openai",
        modelId: "gpt-4.1",
        runs: 3,
        successes: 2,
        failures: 1,
        lastUsedAt: "2026-03-19T12:00:00.000Z",
        lastFailedAt: "2026-03-19T11:00:00.000Z",
      },
    ]);
  });
});

describe("buildModelSuggestions", () => {
  it("ranks only models the Space can run now", async () => {
    const findMany = vi.fn().mockResolvedValue([
      {
        modelProvider: "openai",
        modelId: "gpt-4.1",
        status: "completed",
        completedAt: new Date("2026-03-19T12:00:00.000Z"),
      },
      {
        modelProvider: "anthropic",
        modelId: "claude-sonnet-4",
        status: "completed",
        completedAt: new Date("2026-03-18T12:00:00.000Z"),
      },
      // Used before, but the connection is gone — must not consume a slot.
      {
        modelProvider: "google",
        modelId: "gemini-2.5-pro",
        status: "completed",
        completedAt: new Date("2026-03-19T18:00:00.000Z"),
      },
    ]);
    const prisma = { run: { findMany } } as never;

    const suggestions = await buildModelSuggestions(
      prisma,
      { userId: "user-1", spaceId: "space-1" },
      [
        catalogEntry("openai", "gpt-4.1"),
        catalogEntry("anthropic", "claude-sonnet-4"),
        catalogEntry("google", "gemini-2.5-pro"),
      ],
      [credential("openai"), credential("anthropic")],
      { now: NOW },
    );

    expect(suggestions.map((entry) => entry.modelId)).toEqual(["gpt-4.1", "claude-sonnet-4"]);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: "user-1",
          spaceId: "space-1",
          status: { in: ["completed", "failed"] },
        }),
        orderBy: { completedAt: "desc" },
        take: 500,
      }),
    );
  });

  it("returns nothing when the Space has no runnable models", async () => {
    const findMany = vi.fn();
    const prisma = { run: { findMany } } as never;
    const suggestions = await buildModelSuggestions(
      prisma,
      { userId: "user-1", spaceId: "space-1" },
      [catalogEntry("openai", "gpt-4.1")],
      [],
      { now: NOW },
    );
    expect(suggestions).toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });
});
