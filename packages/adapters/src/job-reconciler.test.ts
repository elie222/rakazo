import type { BackgroundJob, JobPublisher } from "@rakazo/adapter-kit";
import type { Pool, PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import {
  createJobReconciler,
  createPostgresReconciliationLeadership,
  type ReconciliationLeadership,
} from "./job-reconciler.js";

function publisher() {
  const enqueue = vi.fn(async (_job: BackgroundJob) => undefined);
  const jobs: JobPublisher = {
    enqueue,
    cancel: async () => undefined,
    close: async () => undefined,
  };
  return { jobs, enqueue };
}

function fakePrisma(
  runs: Array<{ id: string; updatedAt: Date }> = [],
  routines: Array<{ id: string; nextRunAt: Date | null }> = [],
) {
  return {
    run: { findMany: vi.fn(async () => runs) },
    routine: { findMany: vi.fn(async () => routines) },
  } as unknown as PrismaClient;
}

describe("createJobReconciler", () => {
  it("restores queued runs and near-due routines with stable replacement keys", async () => {
    const scheduledFor = new Date(Date.now() + 30_000);
    const prisma = fakePrisma(
      [{ id: "run-1", updatedAt: new Date() }],
      [{ id: "routine-1", nextRunAt: scheduledFor }],
    );
    const { jobs, enqueue } = publisher();
    const reconciler = createJobReconciler({ prisma, jobs });

    await reconciler.reconcileOnce();

    expect(enqueue).toHaveBeenCalledWith({
      name: "run.continue",
      payload: { runId: "run-1" },
      replaceKey: "run:run-1",
    });
    expect(enqueue).toHaveBeenCalledWith({
      name: "routine.wakeup",
      payload: { routineId: "routine-1", scheduledFor: scheduledFor.toISOString() },
      availableAt: scheduledFor,
      replaceKey: "routine:routine-1",
    });
  });

  it("advances stable cursors so recoverable work beyond one batch is dispatched", async () => {
    const at = new Date("2026-01-01T00:00:00.000Z");
    const runs = Array.from({ length: 5 }, (_, index) => ({
      id: `run-${index + 1}`,
      updatedAt: at,
    }));
    const routines = Array.from({ length: 5 }, (_, index) => ({
      id: `routine-${index + 1}`,
      nextRunAt: new Date(at.getTime() + index),
    }));
    const runFindMany = vi
      .fn()
      .mockResolvedValueOnce(runs.slice(0, 2))
      .mockResolvedValueOnce(runs.slice(2, 4))
      .mockResolvedValueOnce(runs.slice(4));
    const routineFindMany = vi
      .fn()
      .mockResolvedValueOnce(routines.slice(0, 2))
      .mockResolvedValueOnce(routines.slice(2, 4))
      .mockResolvedValueOnce(routines.slice(4));
    const prisma = {
      run: { findMany: runFindMany },
      routine: { findMany: routineFindMany },
    } as unknown as PrismaClient;
    const { jobs, enqueue } = publisher();
    const reconciler = createJobReconciler({ prisma, jobs }, { batchSize: 2 });

    await reconciler.reconcileOnce();
    await reconciler.reconcileOnce();
    await reconciler.reconcileOnce();

    expect(enqueue).toHaveBeenCalledTimes(10);
    expect(enqueue.mock.calls.map(([job]) => job.replaceKey)).toEqual([
      "run:run-1",
      "run:run-2",
      "routine:routine-1",
      "routine:routine-2",
      "run:run-3",
      "run:run-4",
      "routine:routine-3",
      "routine:routine-4",
      "run:run-5",
      "routine:routine-5",
    ]);
    expect(runFindMany.mock.calls[1]?.[0]).toMatchObject({
      orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
      where: {
        AND: [
          expect.anything(),
          {
            OR: [{ updatedAt: { gt: at } }, { updatedAt: at, id: { gt: "run-2" } }],
          },
        ],
      },
    });
    expect(routineFindMany.mock.calls[1]?.[0]).toMatchObject({
      orderBy: [{ nextRunAt: "asc" }, { id: "asc" }],
      where: {
        AND: [
          expect.anything(),
          {
            OR: [
              { nextRunAt: { gt: routines[1]?.nextRunAt } },
              {
                nextRunAt: routines[1]?.nextRunAt,
                id: { gt: "routine-2" },
              },
            ],
          },
        ],
      },
    });
  });

  it("does not scan when another replica is the reconciliation leader", async () => {
    const prisma = fakePrisma();
    const leadership: ReconciliationLeadership = {
      tryAcquire: vi.fn(async () => false),
      release: vi.fn(async () => undefined),
    };
    const { jobs, enqueue } = publisher();
    const reconciler = createJobReconciler({ prisma, jobs, leadership });

    await reconciler.reconcileOnce();
    await reconciler.stop();

    expect(prisma.run.findMany).not.toHaveBeenCalled();
    expect(prisma.routine.findMany).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
    expect(leadership.release).toHaveBeenCalledOnce();
  });
});

describe("createPostgresReconciliationLeadership", () => {
  it("retains leadership for one replica and transfers it after release", async () => {
    let locked = false;
    const clients: Array<{
      query: ReturnType<typeof vi.fn>;
      release: ReturnType<typeof vi.fn>;
      once: ReturnType<typeof vi.fn>;
      removeListener: ReturnType<typeof vi.fn>;
    }> = [];
    const pool = {
      connect: vi.fn(async () => {
        const client = {
          query: vi.fn(async (sql: string) => {
            if (sql.includes("pg_try_advisory_lock")) {
              const acquired = !locked;
              if (acquired) locked = true;
              return { rows: [{ acquired }] };
            }
            const released = locked;
            locked = false;
            return { rows: [{ released }] };
          }),
          release: vi.fn(),
          once: vi.fn(),
          removeListener: vi.fn(),
        };
        clients.push(client);
        return client;
      }),
    } as unknown as Pick<Pool, "connect">;
    const first = createPostgresReconciliationLeadership(pool);
    const second = createPostgresReconciliationLeadership(pool);

    await expect(first.tryAcquire()).resolves.toBe(true);
    await expect(first.tryAcquire()).resolves.toBe(true);
    await expect(second.tryAcquire()).resolves.toBe(false);
    expect(pool.connect).toHaveBeenCalledTimes(2);
    expect(clients[1]?.release).toHaveBeenCalledOnce();

    await first.release();
    await expect(second.tryAcquire()).resolves.toBe(true);
    expect(clients[0]?.removeListener).toHaveBeenCalledWith("error", expect.any(Function));
    expect(clients[0]?.release).toHaveBeenCalledWith(false);
  });
});
