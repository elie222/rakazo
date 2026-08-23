import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { createRunExecutor } from "./executor.js";

describe("createRunExecutor", () => {
  it("uses the first release from the current takeover wait", async () => {
    const waitingSince = new Date("2026-08-23T14:00:00.000Z");
    const findFirst = vi.fn(async () => ({ payload: { reason: "skipped" } }));
    const prisma = {
      run: {
        findUnique: vi.fn(async () => ({
          id: "run-1",
          botId: "bot-1",
          status: "waiting_takeover",
          updatedAt: waitingSince,
          leaseFence: 0,
        })),
        updateMany: vi.fn(async () => ({ count: 0 })),
      },
      event: { findFirst },
    } as unknown as PrismaClient;
    const executor = createRunExecutor({ prisma } as Parameters<typeof createRunExecutor>[0]);

    await executor.continueRun("run-1", "worker-1");

    expect(findFirst).toHaveBeenCalledWith({
      where: {
        botId: "bot-1",
        runId: "run-1",
        type: "computer.takeover.released",
        createdAt: { gte: waitingSince },
      },
      orderBy: [{ createdAt: "asc" }, { seq: "asc" }],
      select: { payload: true },
    });
  });
});
