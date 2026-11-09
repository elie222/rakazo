import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { PrismaClient } from "@rakazo/db";
import { asSystem, createDb, provisionMessagingIdentity, runAsSystem } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { releaseComputerExecutionLease, waitForRunComputerLease } from "./computer-lifecycle.js";

const url = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE === "1" && url ? describe.sequential : describe.skip;

describePostgres("subagent computer coordination", () => {
  let prisma: PrismaClient;
  let close: () => Promise<void>;
  let identity: Awaited<ReturnType<typeof provisionMessagingIdentity>>;
  let computerId: string;

  beforeAll(async () => {
    const db = createDb(url!);
    prisma = asSystem(db.prisma);
    identity = await runAsSystem("subagent computer fixture", () =>
      provisionMessagingIdentity(
        db.prisma,
        { provider: "email", address: `subagent-${randomUUID()}@example.test` },
        { signupsEnabled: undefined, signupAllowlist: undefined },
      ),
    );
    computerId = (await prisma.bot.findUniqueOrThrow({ where: { id: identity.botId } }))
      .computerId!;
    close = async () => {
      await prisma.organization.deleteMany({ where: { id: identity.spaceId } });
      await prisma.user.deleteMany({ where: { id: identity.userId } });
      await db.prisma.$disconnect();
      await db.pool.end();
    };
  });
  afterAll(async () => close?.());

  async function running(trigger: string, botId = identity.botId) {
    const thread =
      trigger === "helper"
        ? await prisma.thread.create({
            data: { spaceId: identity.spaceId, userId: identity.userId, helperBotId: botId },
          })
        : await prisma.thread.upsert({
            where: { botId },
            create: { spaceId: identity.spaceId, userId: identity.userId, botId },
            update: {},
          });
    const task = await prisma.task.create({
      data: {
        spaceId: identity.spaceId,
        userId: identity.userId,
        botId,
        threadId: thread.id,
        prompt: "Complete the delegated task",
        status: "running",
      },
    });
    const run = await prisma.run.create({
      data: {
        spaceId: identity.spaceId,
        userId: identity.userId,
        botId,
        threadId: thread.id,
        taskId: task.id,
        trigger,
        status: "running",
        leaseOwner: "worker",
        leaseFence: 1,
        leaseExpiresAt: new Date(Date.now() + 300_000),
      },
    });
    return { computerId, botId, runId: run.id, workerId: "worker", runFence: 1 };
  }

  it("serializes one bot's screen while allowing a different bot on the Team Computer", async () => {
    const helper = await running("helper");
    const parent = await running("user");
    const controller = new AbortController();
    const first = await waitForRunComputerLease(prisma, helper, controller.signal);
    let parentClaimed = false;
    const waiting = waitForRunComputerLease(prisma, parent, controller.signal).then((lease) => {
      parentClaimed = true;
      return lease;
    });
    const peer = await prisma.bot.create({
      data: {
        name: "Peer",
        color: "gray",
        spaceId: identity.spaceId,
        userId: identity.userId,
        computerId,
      },
    });
    const other = await running("user", peer.id);
    const peerLease = await waitForRunComputerLease(prisma, other, controller.signal);
    expect(peerLease?.botId).toBe(peer.id);
    expect(parentClaimed).toBe(false);
    expect(
      (await prisma.run.findUniqueOrThrow({ where: { id: parent.runId } })).computerUseStartedAt,
    ).toBeNull();
    expect(
      (await prisma.run.findUniqueOrThrow({ where: { id: helper.runId } })).computerUseStartedAt,
    ).not.toBeNull();
    await releaseComputerExecutionLease(prisma, first);
    const next = await waiting;
    expect(next?.runId).toBe(parent.runId);
    expect(next!.fence).toBeGreaterThan(first!.fence);
    await releaseComputerExecutionLease(prisma, next);
    await releaseComputerExecutionLease(prisma, peerLease);
  });

  it("serializes a Private Computer with the same fencing protocol", async () => {
    await prisma.computer.update({ where: { id: computerId }, data: { scope: "dedicated" } });
    const helper = await running("helper");
    const parent = await running("user");
    const signal = new AbortController().signal;
    const first = await waitForRunComputerLease(prisma, helper, signal);
    const next = waitForRunComputerLease(prisma, parent, signal);
    await delay(20);
    expect(
      (await prisma.run.findUniqueOrThrow({ where: { id: parent.runId } })).computerUseStartedAt,
    ).toBeNull();
    await releaseComputerExecutionLease(prisma, first);
    const second = await next;
    expect(second!.fence).toBeGreaterThan(first!.fence);
    await releaseComputerExecutionLease(prisma, second);
  });

  it("aborts a resource wait without stealing the holder's lease", async () => {
    const holder = await running("helper");
    const waiter = await running("helper");
    const holding = await waitForRunComputerLease(prisma, holder, new AbortController().signal);
    const controller = new AbortController();
    const waiting = waitForRunComputerLease(prisma, waiter, controller.signal);
    const rejected = expect(waiting).rejects.toThrow("cancelled");
    await delay(20);
    controller.abort(new Error("cancelled"));
    await rejected;
    const lease = await prisma.computerExecutionLease.findUniqueOrThrow({
      where: { computerId_botId: { computerId, botId: holder.botId } },
    });
    expect(lease.runId).toBe(holder.runId);
    expect(lease.fence).toBe(holding?.fence);
    await releaseComputerExecutionLease(prisma, holding);
  });
});
