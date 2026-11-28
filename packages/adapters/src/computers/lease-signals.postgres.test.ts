import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@rakazo/db";
import {
  asSystem,
  computerLeaseTopic,
  createDb,
  provisionMessagingIdentity,
  runAsSystem,
  runLeaseTopic,
} from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PostgresRealtimeFanout } from "../notifications/realtime.js";
import { renewRunLease } from "../runs/lifecycle/run-lifecycle.js";
import {
  releaseComputerExecutionLease,
  renewComputerExecutionLease,
} from "./computer-lifecycle.js";

const url = process.env.DATABASE_URL;
const describePostgres = process.env.VERIFY_DATABASE === "1" && url ? describe : describe.skip;

describePostgres("lease change signals", () => {
  let prisma: PrismaClient;
  let realtime: PostgresRealtimeFanout;
  let close: () => Promise<void>;
  let identity: Awaited<ReturnType<typeof provisionMessagingIdentity>>;

  beforeAll(async () => {
    const db = createDb(url!);
    prisma = asSystem(db.prisma);
    realtime = new PostgresRealtimeFanout({ connectionString: url!, publisher: db.pool });
    identity = await runAsSystem("lease signal fixture", () =>
      provisionMessagingIdentity(db.prisma, {
        provider: "email",
        address: `lease-signal-${randomUUID()}@example.test`,
      }),
    );
    close = async () => {
      await realtime.close();
      await prisma.organization.deleteMany({ where: { id: identity.spaceId } });
      await prisma.user.deleteMany({ where: { id: identity.userId } });
      await db.prisma.$disconnect();
      await db.pool.end();
    };
  });
  afterAll(async () => close?.());

  /**
   * Every signal the writes sent to the topic. Signals arrive in commit order, so they are all
   * in once an end marker published after the writes is.
   */
  async function signalsDuring(topic: string, writes: () => Promise<void>) {
    const signals: string[] = [];
    let live = false;
    await realtime.subscribe(topic, (payload) => {
      if (payload === "live") live = true;
      else if (live) signals.push(payload);
    });
    // The listener may still be connecting, so mark it live with a signal it receives.
    await vi.waitFor(async () => {
      await realtime.publish(topic, "live");
      expect(live).toBe(true);
    });
    await writes();
    await realtime.publish(topic, "end");
    await vi.waitFor(() => expect(signals).toContain("end"));
    return signals.filter((payload) => payload !== "end");
  }

  it("signals a run's lease topic when it is cancelled, not when its lease renews", async () => {
    const thread = await prisma.thread.upsert({
      where: { botId: identity.botId },
      create: { spaceId: identity.spaceId, userId: identity.userId, botId: identity.botId },
      update: {},
    });
    const task = await prisma.task.create({
      data: {
        spaceId: identity.spaceId,
        userId: identity.userId,
        botId: identity.botId,
        threadId: thread.id,
        prompt: "Work",
        status: "running",
      },
    });
    const run = await prisma.run.create({
      data: {
        spaceId: identity.spaceId,
        userId: identity.userId,
        botId: identity.botId,
        threadId: thread.id,
        taskId: task.id,
        trigger: "user",
        status: "running",
        leaseOwner: "worker",
        leaseFence: 1,
        leaseExpiresAt: new Date(Date.now() + 300_000),
      },
    });
    const signals = await signalsDuring(runLeaseTopic(run.id), async () => {
      expect(await renewRunLease({ prisma } as never, run.id, "worker", 1)).toBe(true);
      await prisma.run.update({ where: { id: run.id }, data: { status: "cancelled" } });
    });
    expect(signals).toEqual([""]);
  });

  it("signals a computer's lease topic when its lease is released, not when it renews", async () => {
    const computerId = (await prisma.bot.findUniqueOrThrow({ where: { id: identity.botId } }))
      .computerId!;
    const lease = { computerId, botId: identity.botId, runId: "run-holding", fence: 1 };
    await prisma.computerExecutionLease.create({
      data: { ...lease, expiresAt: new Date(Date.now() + 300_000) },
    });
    const signals = await signalsDuring(computerLeaseTopic(computerId), async () => {
      expect(await renewComputerExecutionLease(prisma, lease)).toBe(true);
      await releaseComputerExecutionLease(prisma, lease);
    });
    expect(signals).toEqual([""]);
  });
});
