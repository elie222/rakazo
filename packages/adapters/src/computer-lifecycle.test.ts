import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import {
  acquireComputerExecutionLease,
  releaseComputerExecutionLease,
  renewComputerExecutionLease,
} from "./computer-lifecycle.js";

describe("computer execution leases", () => {
  it("does not serialize dedicated computers", async () => {
    const prisma = leasePrisma({ scope: "dedicated" });

    await expect(
      acquireComputerExecutionLease(prisma.client, {
        computerId: "computer-1",
        runId: "run-1",
        botId: "bot-1",
      }),
    ).resolves.toBeNull();
    expect(prisma.updateMany).not.toHaveBeenCalled();
  });

  it("fences Team Computer use and releases only the matching lease", async () => {
    const prisma = leasePrisma({ scope: "team", acquired: 1, fence: 7 });
    const lease = await acquireComputerExecutionLease(prisma.client, {
      computerId: "computer-1",
      runId: "run-1",
      botId: "bot-1",
    });

    expect(lease).toEqual({ computerId: "computer-1", runId: "run-1", fence: 7 });
    expect(prisma.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "computer-1" }),
        data: expect.objectContaining({
          executionRunId: "run-1",
          executionBotId: "bot-1",
          executionFence: { increment: 1 },
        }),
      }),
    );

    prisma.updateMany.mockClear();
    await expect(renewComputerExecutionLease(prisma.client, lease)).resolves.toBe(true);
    await releaseComputerExecutionLease(prisma.client, lease);
    expect(prisma.updateMany).toHaveBeenLastCalledWith({
      where: { id: "computer-1", executionRunId: "run-1", executionFence: 7 },
      data: {
        executionRunId: null,
        executionBotId: null,
        executionLeaseExpiresAt: null,
      },
    });
  });

  it("rejects a second Team Computer run while the lease is held", async () => {
    const prisma = leasePrisma({ scope: "team", acquired: 0 });

    await expect(
      acquireComputerExecutionLease(prisma.client, {
        computerId: "computer-1",
        runId: "run-2",
        botId: "bot-2",
      }),
    ).rejects.toThrow("Computer is busy");
  });
});

function leasePrisma(options: { scope: string; acquired?: number; fence?: number }) {
  const updateMany = vi.fn().mockResolvedValue({ count: options.acquired ?? 1 });
  const computer = {
    findUniqueOrThrow: vi
      .fn()
      .mockResolvedValueOnce({ scope: options.scope })
      .mockResolvedValue({ executionFence: options.fence ?? 1 }),
    updateMany,
  };
  return {
    client: { computer } as unknown as PrismaClient,
    updateMany,
  };
}
