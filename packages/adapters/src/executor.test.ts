import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { createRunExecutor } from "./executor.js";

describe("createRunExecutor", () => {
  it("consumes a persisted takeover checkpoint when claiming the run", async () => {
    const updateMany = vi.fn(async () => ({ count: 0 }));
    const prisma = {
      run: {
        findUnique: vi.fn(async () => ({
          id: "run-1",
          botId: "bot-1",
          status: "queued",
          checkpoint: "takeover-skipped",
          leaseFence: 0,
        })),
        updateMany,
      },
    } as unknown as PrismaClient;
    const executor = createRunExecutor({ prisma } as Parameters<typeof createRunExecutor>[0]);

    await executor.continueRun("run-1", "worker-1");

    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ checkpoint: null }),
      }),
    );
  });

  it("restores a takeover checkpoint when a switching computer requeues the run", async () => {
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const enqueue = vi.fn(async () => undefined);
    const prisma = {
      run: {
        findUnique: vi.fn(async () => ({
          id: "run-1",
          botId: "bot-1",
          status: "queued",
          checkpoint: "takeover-skipped",
          leaseFence: 0,
        })),
        findUniqueOrThrow: vi.fn(async () => ({ status: "leased", startedAt: null })),
        updateMany,
      },
      bot: {
        findUniqueOrThrow: vi.fn(async () => ({
          computerId: "computer-1",
          computerSwitching: true,
        })),
      },
    } as unknown as PrismaClient;
    const executor = createRunExecutor({ prisma, jobs: { enqueue } } as unknown as Parameters<
      typeof createRunExecutor
    >[0]);

    await executor.continueRun("run-1", "worker-1");

    expect(updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "queued",
          checkpoint: "takeover-skipped",
        }),
      }),
    );
    expect(enqueue).toHaveBeenCalledOnce();
  });
});
