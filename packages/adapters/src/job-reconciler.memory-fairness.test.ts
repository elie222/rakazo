import type { BackgroundJob, JobPublisher } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { createJobReconciler } from "./job-reconciler.js";

type Row = { id: string; threadId: string; botId: string; memoryCaptureDueAt: Date };

function fixture(rows: Row[], options: { batchSize?: number; maxPagesPerPass?: number } = {}) {
  const enqueue = vi.fn(async (_job: BackgroundJob) => undefined);
  const findMany = vi.fn(
    async (args: {
      where?: {
        memoryCapturedAt?: unknown;
        OR?: Array<{ memoryCaptureDueAt: Date | { gt: Date }; id?: { gt: string } }>;
      };
      take?: number;
      distinct?: string[];
    }) => {
      if (args.where?.memoryCapturedAt !== null) return [];
      const cursor = args.where.OR;
      const afterAt = cursor?.[0]?.memoryCaptureDueAt;
      const afterId = cursor?.[1]?.id?.gt;
      const seen = new Set<string>();
      return [...rows]
        .sort((a, b) => +a.memoryCaptureDueAt - +b.memoryCaptureDueAt || a.id.localeCompare(b.id))
        .filter((row) => {
          if (
            afterAt &&
            "gt" in afterAt &&
            !(
              row.memoryCaptureDueAt > afterAt.gt ||
              (+row.memoryCaptureDueAt === +afterAt.gt && row.id > afterId!)
            )
          )
            return false;
          const key = (args.distinct ?? ["id"]).map((field) => row[field as keyof Row]).join(":");
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        })
        .slice(0, args.take);
    },
  );
  const prisma = {
    computerExecutionLease: { findMany: async () => [] },
    message: { findMany: async () => [] },
    routine: { findMany: async () => [] },
    computer: { findMany: async () => [] },
    messagingOutbound: { findFirst: async () => null },
    run: { findMany, updateMany: vi.fn(async () => ({ count: 0 })) },
  } as unknown as PrismaClient;
  const jobs: JobPublisher = {
    enqueue,
    cancel: async () => undefined,
    close: async () => undefined,
  };
  return {
    enqueue,
    findMany,
    prisma,
    reconciler: () => createJobReconciler({ prisma, jobs }, options),
  };
}

function rows(count: number): Row[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `run-${String(index).padStart(4, "0")}`,
    threadId: `independent-thread-${index}`,
    botId: `independent-bot-${index}`,
    // All due times tie, so progressing only by timestamp is insufficient.
    memoryCaptureDueAt: new Date("2026-01-01T00:00:00Z"),
  }));
}

function capturedIds(enqueue: ReturnType<typeof fixture>["enqueue"]) {
  return enqueue.mock.calls
    .filter(([job]) => job.name === "memory.capture")
    .map(([job]) => (job.payload as { runId: string }).runId);
}

describe("fair memory capture reconciliation", () => {
  it("reaches independent conversations beyond a full unchanged oldest-100 page", async () => {
    const pending = rows(205);
    const f = fixture(pending);
    const reconciler = f.reconciler();
    for (let pass = 0; pass < 3; pass += 1) await reconciler.reconcileOnce();
    expect(new Set(capturedIds(f.enqueue))).toEqual(new Set(pending.map((row) => row.id)));
    expect(f.prisma.run.updateMany).not.toHaveBeenCalled();
  });

  it("drains beyond oldest-100 even when a leader is reconstructed before each pass", async () => {
    const pending = rows(205);
    const f = fixture(pending);
    for (let restart = 0; restart < 3; restart += 1) await f.reconciler().reconcileOnce();
    expect(new Set(capturedIds(f.enqueue))).toEqual(new Set(pending.map((row) => row.id)));
  });

  it("resumes a bounded scan on later ticks then wraps to newly inserted older work", async () => {
    const pending = rows(205);
    const f = fixture(pending, { maxPagesPerPass: 1 });
    const reconciler = f.reconciler();
    await reconciler.reconcileOnce();
    expect(capturedIds(f.enqueue)).toHaveLength(100);
    await reconciler.reconcileOnce();
    expect(capturedIds(f.enqueue)).toHaveLength(200);
    await reconciler.reconcileOnce();
    expect(capturedIds(f.enqueue)).toEqual(pending.map((row) => row.id));
    pending.unshift({
      id: "new-older-row",
      threadId: "new-thread",
      botId: "new-bot",
      memoryCaptureDueAt: new Date(0),
    });
    await reconciler.reconcileOnce();
    expect(capturedIds(f.enqueue)).toContain("new-older-row");
  });

  it("settles enqueue failure without advancing past the failed memory page", async () => {
    const pending = rows(205);
    const f = fixture(pending, { maxPagesPerPass: 1 });
    const reconciler = f.reconciler();
    f.enqueue.mockRejectedValueOnce(new Error("synthetic queue failure"));
    await expect(reconciler.reconcileOnce()).rejects.toThrow("synthetic queue failure");
    await reconciler.reconcileOnce();
    const ids = capturedIds(f.enqueue);
    expect(ids.slice(0, 100)).toEqual(ids.slice(100, 200));
    await reconciler.reconcileOnce();
    expect(capturedIds(f.enqueue).slice(200, 300)).toEqual(
      pending.slice(100, 200).map((row) => row.id),
    );
  });

  it("keeps bot conversations distinct and never relies on captured rows disappearing", async () => {
    const pending = rows(205);
    for (const row of pending) row.threadId = "synthetic-group-thread";
    const f = fixture(pending, { batchSize: 100, maxPagesPerPass: 1 });
    const reconciler = f.reconciler();
    for (let pass = 0; pass < 3; pass += 1) await reconciler.reconcileOnce();
    expect(capturedIds(f.enqueue)).toEqual(pending.map((row) => row.id));
  });
});
