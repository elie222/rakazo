import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import {
  acquireEmployeeEvaluationLease,
  releaseEmployeeEvaluationLease,
} from "./evaluation-lease.js";

describe("employee evaluation lease", () => {
  const now = new Date("2026-08-30T00:00:00.000Z");

  it("only returns a lease after a conditional durable claim", async () => {
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const findFirst = vi.fn(async () => ({ leaseFence: 7 }));
    const prisma = { employeeRuntimeState: { updateMany, findFirst } } as unknown as PrismaClient;

    await expect(
      acquireEmployeeEvaluationLease(prisma, {
        workspaceId: "workspace-1",
        botId: "bot-1",
        owner: "worker:attempt",
        now,
      }),
    ).resolves.toEqual({
      owner: "worker:attempt",
      fence: 7,
      expiresAt: new Date("2026-08-30T00:01:00.000Z"),
    });
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          workspaceId: "workspace-1",
          botId: "bot-1",
          OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }],
        }),
      }),
    );
  });

  it("does not evaluate when another worker owns a live lease", async () => {
    const findFirst = vi.fn();
    const prisma = {
      employeeRuntimeState: { updateMany: vi.fn(async () => ({ count: 0 })), findFirst },
    } as unknown as PrismaClient;

    await expect(
      acquireEmployeeEvaluationLease(prisma, {
        workspaceId: "workspace-1",
        botId: "bot-1",
        owner: "worker:attempt",
        now,
      }),
    ).resolves.toBeNull();
    expect(findFirst).not.toHaveBeenCalled();
  });

  it("releases only the exact owner and fence", async () => {
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const prisma = { employeeRuntimeState: { updateMany } } as unknown as PrismaClient;

    await expect(
      releaseEmployeeEvaluationLease(prisma, {
        workspaceId: "workspace-1",
        botId: "bot-1",
        lease: { owner: "worker:attempt", fence: 7, expiresAt: new Date() },
        status: "sleeping",
        nextWakeAt: now,
      }),
    ).resolves.toBe(true);
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ leaseOwner: "worker:attempt", leaseFence: 7 }),
      }),
    );
  });
});
