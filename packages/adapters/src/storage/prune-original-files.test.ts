import type { ArtifactStore } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { createOriginalFilesPruner } from "./prune-original-files.js";

const DAY = 24 * 60 * 60_000;
const HOUR = 60 * 60_000;

describe("createOriginalFilesPruner", () => {
  it("does nothing, and queries nothing, while both switches are off", () => {
    const queryRaw = vi.fn();
    const off = createOriginalFilesPruner({
      prisma: { $queryRaw: queryRaw } as unknown as PrismaClient,
      artifacts: {} as ArtifactStore,
      settings: { received: false, created: false, maxAgeMs: 31 * DAY, intervalMs: DAY },
    });
    expect(off).toBeUndefined();
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it("does not look again within the interval, then looks once it has passed", async () => {
    const queryRaw = vi.fn(async () => []);
    let now = new Date("2026-11-18T12:00:00Z");
    const prune = createOriginalFilesPruner({
      prisma: { $queryRaw: queryRaw } as unknown as PrismaClient,
      artifacts: {} as ArtifactStore,
      settings: { received: true, created: false, maxAgeMs: 31 * DAY, intervalMs: 6 * HOUR },
      now: () => now,
    });

    await prune!();
    now = new Date(now.getTime() + 5 * HOUR);
    await prune!();
    expect(queryRaw).toHaveBeenCalledOnce();

    now = new Date(now.getTime() + 2 * HOUR);
    await prune!();
    expect(queryRaw).toHaveBeenCalledTimes(2);
  });
});
