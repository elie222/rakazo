import type { BackgroundJob, JobPublisher } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { createJobReconciler } from "./job-reconciler.js";

type Due = { id: string; threadId: string; botId: string; due: Date };
function fixture(rows: Due[], sweepThrows = false) {
  const enqueue = vi.fn(async (_job: BackgroundJob) => undefined);
  const prisma = {
    computerExecutionLease: { findMany: vi.fn(async () => []) },
    message: { findMany: vi.fn(async () => []) },
    routine: { findMany: vi.fn(async () => []) },
    computer: { findMany: vi.fn(async () => []) },
    messagingOutbound: { findFirst: vi.fn(async () => null) },
    run: {
      findMany: vi.fn(
        async (args: { where?: Record<string, unknown>; distinct?: string[]; take?: number }) => {
          if (!args.where || !("memoryCaptureDueAt" in args.where)) return [];
          const filter = args.where.memoryCaptureDueAt as { gte?: Date };
          const selected = rows.filter((row) => !filter.gte || row.due >= filter.gte);
          const seen = new Set<string>();
          return selected
            .filter((row) => {
              const key = (args.distinct ?? ["id"])
                .map((field) => row[field as keyof Due])
                .join(":");
              if (seen.has(key)) return false;
              seen.add(key);
              return true;
            })
            .slice(0, args.take)
            .map(({ id }) => ({ id }));
        },
      ),
      updateMany: vi.fn(async () => {
        if (sweepThrows) throw new Error("maintenance scan timed out");
        return { count: 0 };
      }),
    },
  };
  const jobs = {
    enqueue,
    cancel: async () => undefined,
    close: async () => undefined,
  } as JobPublisher;
  return {
    prisma,
    enqueue,
    reconciler: createJobReconciler({ prisma: prisma as unknown as PrismaClient, jobs }),
  };
}

describe("PR recovery regressions", () => {
  it("recovers an old pending capture after an extended outage", async () => {
    const { enqueue, reconciler } = fixture([
      { id: "old-turn", threadId: "thread-1", botId: "bot-1", due: new Date(0) },
    ]);
    await reconciler.reconcileOnce();
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ name: "memory.capture", payload: { runId: "old-turn" } }),
    );
  });

  it("recovers independent bot conversations from the same group thread", async () => {
    const { enqueue, reconciler } = fixture([
      { id: "turn-a", threadId: "group-1", botId: "bot-a", due: new Date() },
      { id: "turn-b", threadId: "group-1", botId: "bot-b", due: new Date() },
    ]);
    await reconciler.reconcileOnce();
    const ids = enqueue.mock.calls
      .filter(([job]) => job.name === "memory.capture")
      .map(([job]) => (job.payload as { runId: string }).runId);
    expect(ids).toEqual(["turn-a", "turn-b"]);
  });

  it("does not clear frozen pending evidence in the wakeup reconciler", async () => {
    const { prisma, enqueue, reconciler } = fixture(
      [{ id: "pending", threadId: "thread-1", botId: "bot-1", due: new Date() }],
      true,
    );
    await expect(reconciler.reconcileOnce()).resolves.toBeUndefined();
    expect(prisma.run.updateMany).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ name: "memory.capture" }));
  });
});
