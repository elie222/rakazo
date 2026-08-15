import type { BackgroundJob, JobPublisher } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { createJobReconciler } from "./job-reconciler.js";

function publisher() {
  const enqueue = vi.fn(async (_job: BackgroundJob) => undefined);
  const jobs: JobPublisher = {
    enqueue,
    cancel: async () => undefined,
    close: async () => undefined,
  };
  return { jobs, enqueue };
}

describe("createJobReconciler", () => {
  it("restores queued runs and near-due routines with stable replacement keys", async () => {
    const scheduledFor = new Date(Date.now() + 30_000);
    const prisma = {
      run: { findMany: vi.fn(async () => [{ id: "run-1" }]) },
      routine: {
        findMany: vi.fn(async () => [{ id: "routine-1", nextRunAt: scheduledFor }]),
      },
    } as unknown as PrismaClient;
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
});
