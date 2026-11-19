import { randomUUID } from "node:crypto";
import type { Actor, ThreadSnapshot } from "@rakazo/contracts";
import { reduceThreadSnapshot } from "@rakazo/core";
import { deferred } from "@rakazo/core/test-async";
import type { Prisma, PrismaClient } from "@rakazo/db";
import {
  appendEventInTransaction,
  asSystem,
  createDb,
  createGroupRepos,
  createRepos,
  provisionMessagingIdentity,
  runAsSystem,
  runAsTenant,
} from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { threadSnapshot } from "./thread-snapshot.js";
import type { ThreadTarget } from "./thread-target.js";
import { resolveThreadTarget } from "./thread-target.js";

const databaseUrl = process.env.DATABASE_URL;
const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(databaseUrl);

const WAIT_BUDGET_MS = 5_000;
const WAIT_INTERVAL_MS = 20;
const TRANSACTION_TIMEOUT_MS = 8_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Clients ignore an event at or below their snapshot's cursor, so a snapshot must already show
 * what every such event reports. Each case resolves the target first, as a request does, then
 * changes state and appends its event before the snapshot can take the thread lock.
 */
describe.skipIf(!enabled)("thread snapshot matches its cursor (PostgreSQL)", () => {
  let prisma: PrismaClient;
  let system: PrismaClient;
  let pool: ReturnType<typeof createDb>["pool"];
  let close: () => Promise<void>;
  let provisioned = false;
  let actor: Actor;
  let userId: string;
  let spaceId: string;
  let botId: string;
  let computerId: string;
  let groupId: string;
  const address = `thread-snapshot-consistency-${randomUUID()}`;

  beforeAll(async () => {
    const db = createDb(databaseUrl!);
    prisma = db.prisma;
    system = asSystem(prisma);
    pool = db.pool;
    close = async () => {
      try {
        await prisma.$disconnect();
      } finally {
        await db.pool.end();
      }
    };
    const identity = await runAsSystem("test fixture", () =>
      provisionMessagingIdentity(prisma, { provider: "test", address }),
    );
    provisioned = true;
    ({ userId, spaceId } = identity);
    actor = { userId, spaceId, email: "snapshot@example.test", isDeploymentOwner: false };
    const botIds: string[] = [];
    for (const name of ["Ada", "Ben"]) {
      const bot = await runAsTenant(actor, () =>
        createRepos(prisma).createBot(actor, {
          name,
          description: "",
          instructions: "",
          notifyOnFinish: true,
        }),
      );
      botIds.push(bot.id);
    }
    botId = botIds[0]!;
    const computer = await system.computer.create({
      data: {
        spaceId,
        userId,
        scopeKey: randomUUID(),
        homeKey: randomUUID(),
        kind: "fake",
        state: "running",
      },
    });
    computerId = computer.id;
    await system.bot.update({ where: { id: botId }, data: { computerId } });
    const group = await runAsTenant(actor, () =>
      createGroupRepos(prisma).createGroup(actor, { name: "Snapshot team", botIds }),
    );
    groupId = group.id;
  });

  afterAll(async () => {
    try {
      if (prisma && provisioned) {
        await system.messagingIdentity.deleteMany({ where: { provider: "test", address } });
        await system.organization.deleteMany({ where: { id: spaceId } });
        await system.user.deleteMany({ where: { id: userId } });
      }
    } finally {
      await close?.();
    }
  });

  /**
   * Holds the thread row as an event writer does, starts the snapshot, waits until it queues on
   * that writer, then lets the writer change state and append its event. Returns the snapshot
   * and the event's seq.
   */
  async function snapshotBehindWriter(
    target: ThreadTarget,
    write: (tx: Prisma.TransactionClient) => Promise<number>,
  ): Promise<{ snapshot: ThreadSnapshot; seq: number }> {
    const probe = await runAsSystem("lock probe", () => pool.connect());
    const threadLocked = deferred<string>();
    const resumed = deferred();
    let writer: Promise<number> | undefined;
    let reader: Promise<ThreadSnapshot> | undefined;
    try {
      writer = system.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT id FROM threads WHERE id = ${target.threadId} FOR UPDATE`;
          const rows = await tx.$queryRaw<Array<{ xactId: string }>>`
            SELECT pg_current_xact_id()::text AS "xactId"`;
          threadLocked.resolve(rows[0]?.xactId ?? "");
          await resumed.promise;
          return write(tx);
        },
        { timeout: TRANSACTION_TIMEOUT_MS },
      );
      writer.catch(() => undefined);
      const xactId = await Promise.race([
        threadLocked.promise,
        writer.then(() => {
          throw new Error("the writer finished before it held the thread lock");
        }),
      ]);

      reader = runAsTenant(actor, () => threadSnapshot({ prisma }, target, actor.userId));
      reader.catch(() => undefined);

      const deadline = Date.now() + WAIT_BUDGET_MS;
      for (;;) {
        const result = await probe.query(
          "SELECT count(*)::int AS waiting FROM pg_locks WHERE locktype = 'transactionid' AND NOT granted AND transactionid::text = $1",
          [xactId],
        );
        if ((result.rows[0].waiting as number) > 0) break;
        if (Date.now() >= deadline) throw new Error("the snapshot never queued on the writer");
        await sleep(WAIT_INTERVAL_MS);
      }
      resumed.resolve();

      const [seq, snapshot] = await Promise.all([writer, reader]);
      return { snapshot, seq };
    } finally {
      resumed.resolve();
      await Promise.allSettled([writer, reader]);
      probe.release();
    }
  }

  const groupTarget = () =>
    runAsTenant(actor, () => resolveThreadTarget(prisma, actor, { groupId }));
  const botTarget = () => runAsTenant(actor, () => resolveThreadTarget(prisma, actor, { botId }));

  it("shows a member's run that started and finished after the group was resolved", async () => {
    const idle = await groupTarget();
    const scope = { spaceId, userId, botId, threadId: idle.threadId };
    const runId = randomUUID();
    const started = await snapshotBehindWriter(idle, async (tx) => {
      const task = await tx.task.create({
        data: { ...scope, prompt: "Summarize the sample notes", status: "running" },
      });
      await tx.run.create({
        data: { ...scope, id: runId, taskId: task.id, status: "running", trigger: "user" },
      });
      const event = await appendEventInTransaction(tx, {
        ...scope,
        runId,
        type: "run.started",
        payload: { trigger: "user" },
      });
      return event.seq;
    });
    expect(started.snapshot.cursor).toBe(started.seq);
    expect(started.snapshot.members?.find((member) => member.botId === botId)?.status).toBe(
      "running",
    );
    expect(started.snapshot.members?.find((member) => member.botId !== botId)?.status).toBe("idle");
    // The stream still delivers the event; the client drops it and the indicator stays right.
    expect(
      reduceThreadSnapshot(started.snapshot, {
        type: "run.started",
        seq: started.seq,
        threadId: idle.threadId,
        botId,
        runId,
        payload: { trigger: "user" },
      }),
    ).toBe(started.snapshot);

    const working = await groupTarget();
    const finished = await snapshotBehindWriter(working, async (tx) => {
      await tx.run.update({
        where: { id: runId },
        data: { status: "completed", completedAt: new Date() },
      });
      const event = await appendEventInTransaction(tx, {
        ...scope,
        runId,
        type: "run.completed",
        payload: {},
      });
      return event.seq;
    });
    expect(finished.snapshot.cursor).toBe(finished.seq);
    expect(finished.snapshot.members?.find((member) => member.botId === botId)?.status).toBe(
      "idle",
    );
    expect(finished.snapshot.activeRuns).toEqual([]);
  }, 20_000);

  it("shows a takeover request made after the bot was resolved", async () => {
    const target = await botTarget();
    const scope = { spaceId, userId, botId, threadId: target.threadId };
    const runId = randomUUID();
    const { snapshot, seq } = await snapshotBehindWriter(target, async (tx) => {
      const task = await tx.task.create({
        data: { ...scope, prompt: "Sign in to the sample site", status: "running" },
      });
      await tx.run.create({
        data: { ...scope, id: runId, taskId: task.id, status: "waiting_takeover", trigger: "user" },
      });
      const event = await appendEventInTransaction(tx, {
        ...scope,
        runId,
        type: "computer.takeover.requested",
        payload: { reason: "Sign in", takeoverRequested: true, retainedControl: true },
      });
      return event.seq;
    });
    expect(snapshot.cursor).toBe(seq);
    expect(snapshot.run).toMatchObject({ id: runId, status: "waiting_takeover" });
    expect(snapshot.computer).toMatchObject({ takeoverRequested: true, busyBotName: null });
    await system.run.update({ where: { id: runId }, data: { status: "cancelled" } });
  }, 20_000);

  it("shows control of the computer taken after the bot was resolved", async () => {
    const target = await botTarget();
    const leaseId = randomUUID();
    const { snapshot, seq } = await snapshotBehindWriter(target, async (tx) => {
      await tx.computer.update({
        where: { id: computerId },
        data: {
          controlHolder: "user",
          controlLeaseId: leaseId,
          controlBotId: botId,
          controlUserId: userId,
        },
      });
      const event = await appendEventInTransaction(tx, {
        spaceId,
        threadId: target.threadId,
        botId,
        type: "computer.takeover.granted",
        payload: { leaseId },
      });
      return event.seq;
    });
    expect(snapshot.cursor).toBe(seq);
    expect(snapshot.computer).toMatchObject({
      controlHolder: "user",
      controlBotId: botId,
      controlLeaseId: leaseId,
    });
  }, 20_000);
});
