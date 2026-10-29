import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@rakazo/db";
import { asSystem, createDb, provisionMessagingIdentity, runAsSystem } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  acquireComputerExecutionLease,
  ComputerBusyError,
  holdComputerExecutionLeaseForTakeover,
  releaseComputerExecutionLease,
  renewComputerExecutionLease,
} from "./computer-lifecycle.js";
import { takeoverContinuePlan } from "./takeover-resume.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

describePostgres("Team Computer takeover recovery (PostgreSQL)", () => {
  let prisma: PrismaClient;
  let close: () => Promise<void>;
  let identity: Awaited<ReturnType<typeof provisionMessagingIdentity>>;
  let computerId: string;
  const address = `lease-${randomUUID()}@example.test`;

  beforeAll(async () => {
    const db = createDb(databaseUrl!);
    prisma = asSystem(db.prisma);
    close = async () => {
      await prisma.messagingIdentity.deleteMany({ where: { address } });
      if (identity) {
        await prisma.organization.deleteMany({ where: { id: identity.spaceId } });
        await prisma.user.deleteMany({ where: { id: identity.userId } });
      }
      await db.prisma.$disconnect();
      await db.pool.end();
    };
    identity = await runAsSystem("lease fixture", () =>
      provisionMessagingIdentity(
        db.prisma,
        { provider: "email", address },
        { signupsEnabled: undefined, signupAllowlist: undefined },
      ),
    );
    const bot = await prisma.bot.findUniqueOrThrow({ where: { id: identity.botId } });
    computerId = bot.computerId!;
  });

  afterAll(async () => close?.());

  it("lets API operations acquire new or expired leases without a worker claim", async () => {
    const input = { computerId, botId: identity.botId, runId: "boot:fixture" };
    const first = await acquireComputerExecutionLease(prisma, input);
    expect(first).not.toBeNull();
    await expect(holdComputerExecutionLeaseForTakeover(prisma, first)).resolves.toBe(true);

    // Neither the same operation nor a different API operation may steal a live lease.
    for (const runId of [input.runId, "teach:fixture", "reset:fixture"]) {
      await expect(
        acquireComputerExecutionLease(prisma, { ...input, runId }),
      ).rejects.toBeInstanceOf(ComputerBusyError);
    }
    const held = await prisma.computerExecutionLease.findUniqueOrThrow({
      where: { computerId_botId: { computerId, botId: identity.botId } },
    });
    expect(held.fence).toBe(first!.fence);
    expect(held.expiresAt.getTime()).toBeGreaterThan(Date.now() + 23 * 60 * 60_000);

    await releaseComputerExecutionLease(prisma, first);
    const next = await acquireComputerExecutionLease(prisma, { ...input, runId: "teach:fixture" });
    expect(next).toMatchObject({ runId: "teach:fixture", fence: first!.fence + 1 });
    await expect(renewComputerExecutionLease(prisma, first)).resolves.toBe(false);
    await releaseComputerExecutionLease(prisma, next);
  });

  it("recovers a hold written before waiting_takeover without letting another run steal it", async () => {
    const { spaceId, botId, threadId, userId } = identity;
    const task = await prisma.task.create({
      data: { spaceId, botId, threadId, userId, prompt: "fixture", status: "running" },
    });
    const run = await prisma.run.create({
      data: {
        spaceId,
        botId,
        threadId,
        userId,
        taskId: task.id,
        status: "running",
        trigger: "user",
        leaseOwner: "worker-1",
        leaseFence: 1,
        leaseExpiresAt: new Date(Date.now() + 60_000),
      },
    });
    const input = { computerId, botId, runId: run.id, workerId: "worker-1", runFence: 1 };
    const first = await acquireComputerExecutionLease(prisma, input);
    expect(first).not.toBeNull();
    await expect(holdComputerExecutionLeaseForTakeover(prisma, first)).resolves.toBe(true);
    const held = await prisma.computerExecutionLease.findUniqueOrThrow({
      where: { computerId_botId: { computerId, botId } },
    });
    expect(held.expiresAt.getTime()).toBeGreaterThan(Date.now() + 23 * 60 * 60_000);

    const other = await prisma.run.create({
      data: {
        spaceId,
        botId,
        threadId,
        userId,
        taskId: task.id,
        status: "running",
        trigger: "user",
        leaseOwner: "worker-3",
        leaseFence: 1,
        leaseExpiresAt: new Date(Date.now() + 60_000),
      },
    });
    const otherInput = { ...input, runId: other.id, workerId: "worker-3" };
    await expect(acquireComputerExecutionLease(prisma, otherInput)).rejects.toBeInstanceOf(
      ComputerBusyError,
    );

    // API operations also cannot steal a live worker lease, even with its run id.
    for (const runId of [run.id, "boot:fixture"]) {
      await expect(
        acquireComputerExecutionLease(prisma, { computerId, botId, runId }),
      ).rejects.toBeInstanceOf(ComputerBusyError);
    }

    // Simulate recovery claiming the expired run after a hard kill, before the pause committed.
    await prisma.run.update({
      where: { id: run.id },
      data: { leaseExpiresAt: new Date(0) },
    });
    const observed = await prisma.run.findUniqueOrThrow({ where: { id: run.id } });
    expect(takeoverContinuePlan(observed).heldForTakeover).toBe(false);
    const claimed = await prisma.run.updateMany({
      where: { id: run.id, status: "running", leaseExpiresAt: { lte: new Date() } },
      data: {
        leaseOwner: "worker-2",
        leaseFence: 2,
        leaseExpiresAt: new Date(Date.now() + 60_000),
      },
    });
    expect(claimed.count).toBe(1);
    const recoveryInput = { ...input, workerId: "worker-2", runFence: 2 };
    const recovered = await acquireComputerExecutionLease(prisma, recoveryInput);
    expect(recovered).toMatchObject({ runId: run.id, fence: first!.fence + 1 });
    await expect(renewComputerExecutionLease(prisma, first)).resolves.toBe(false);
    await expect(holdComputerExecutionLeaseForTakeover(prisma, first)).resolves.toBe(false);
    await releaseComputerExecutionLease(prisma, first);

    for (const stale of [
      input,
      { ...recoveryInput, workerId: "worker-1" },
      { ...recoveryInput, runFence: 1 },
    ]) {
      await expect(acquireComputerExecutionLease(prisma, stale)).rejects.toBeInstanceOf(
        ComputerBusyError,
      );
    }
    // A concurrent claim keeps ownership locked until acquisition commits.
    await prisma.$transaction(async (tx) => {
      await tx.run.update({ where: { id: run.id }, data: { leaseFence: 2 } });
      await expect(acquireComputerExecutionLease(prisma, recoveryInput)).rejects.toBeInstanceOf(
        ComputerBusyError,
      );
    });
    const active = await prisma.computerExecutionLease.findUniqueOrThrow({
      where: { computerId_botId: { computerId, botId } },
    });
    expect(active.fence).toBe(recovered!.fence);
    expect(active.expiresAt.getTime()).toBeLessThan(Date.now() + 6 * 60_000);
    await expect(acquireComputerExecutionLease(prisma, otherInput)).rejects.toBeInstanceOf(
      ComputerBusyError,
    );
    await expect(renewComputerExecutionLease(prisma, recovered)).resolves.toBe(true);
    await releaseComputerExecutionLease(prisma, recovered);
    await expect(acquireComputerExecutionLease(prisma, otherInput)).resolves.toMatchObject({
      runId: other.id,
      fence: recovered!.fence + 1,
    });
  });
});
