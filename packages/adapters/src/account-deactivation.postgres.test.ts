import { randomUUID } from "node:crypto";
import type { BackgroundJob } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import {
  appendEvent,
  asSystem,
  cancelDeactivatedAccountRuns,
  createDb,
  provisionMessagingIdentity,
  runAsSystem,
} from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createRunExecutor } from "./executor.js";

const url = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE === "1" && url ? describe.sequential : describe.skip;

type Identity = { userId: string; spaceId: string; botId: string; threadId: string };

describePostgres("a deactivated account's work (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let system: PrismaClient;
  const identities: Identity[] = [];
  const notify = vi.fn(async () => undefined);
  const enqueue = vi.fn(async (_job: BackgroundJob) => undefined);

  beforeAll(() => {
    db = createDb(url!);
    system = asSystem(db.prisma);
  });
  afterAll(async () => {
    for (const identity of identities) {
      await system.organization.deleteMany({ where: { id: identity.spaceId } });
      await system.user.deleteMany({ where: { id: identity.userId } });
    }
    await db?.prisma.$disconnect();
    await db?.pool.end();
  });

  async function person(): Promise<Identity> {
    const { userId, spaceId, botId, threadId } = await runAsSystem("deactivation fixture", () =>
      provisionMessagingIdentity(
        db.prisma,
        { provider: "email", address: `deactivation-${randomUUID()}@rakazo.test` },
        { signupsEnabled: undefined, signupAllowlist: undefined },
      ),
    );
    const identity = { userId, spaceId, botId, threadId };
    identities.push(identity);
    return identity;
  }
  async function run(identity: Identity, status: string) {
    const task = await system.task.create({
      data: { ...identity, prompt: "fixture", status: "queued" },
    });
    return system.run.create({
      data: { ...identity, taskId: task.id, trigger: "chat", status },
    });
  }
  const deactivate = (identity: Identity, at: Date | null = new Date()) =>
    system.user.update({ where: { id: identity.userId }, data: { deactivatedAt: at } });
  const status = async (runId: string) =>
    (await system.run.findUniqueOrThrow({ where: { id: runId } })).status;
  const executor = () =>
    createRunExecutor({
      prisma: system,
      jobs: {
        enqueue,
        cancel: async () => undefined,
        close: async () => undefined,
      },
      events: {
        append: (input: Parameters<typeof appendEvent>[1]) => appendEvent(system, input),
        notify,
      },
    } as unknown as Parameters<typeof createRunExecutor>[0]);

  it("cancels only a deactivated account's active runs, and nothing once it is back", async () => {
    const alice = await person();
    const bob = await person();
    const queued = await run(alice, "queued");
    const waiting = await run(alice, "waiting_input");
    const done = await run(alice, "completed");
    const others = await run(bob, "queued");

    expect(await cancelDeactivatedAccountRuns(system, alice.userId)).toEqual([]);
    expect(await status(queued.id)).toBe("queued");

    await deactivate(alice);
    const events = await cancelDeactivatedAccountRuns(system, alice.userId);
    expect(events).toEqual([{ threadId: alice.threadId, seq: expect.any(Number) }]);
    expect(await status(queued.id)).toBe("cancelled");
    expect(await status(waiting.id)).toBe("cancelled");
    expect(await status(done.id)).toBe("completed");
    expect(await status(others.id)).toBe("queued");
    const cancelled = await system.event.findMany({
      where: { runId: { in: [queued.id, waiting.id] }, type: "run.cancelled" },
    });
    expect(cancelled).toHaveLength(2);
    expect(cancelled[0]?.payload).toMatchObject({ reason: "account_deactivated" });
    expect(await system.task.findUniqueOrThrow({ where: { id: queued.taskId } })).toMatchObject({
      status: "cancelled",
    });
  });

  it("cancels a deactivated account's run when a worker picks it up, before it starts", async () => {
    const carol = await person();
    const queued = await run(carol, "queued");
    await deactivate(carol);
    notify.mockClear();

    await executor().continueRun(queued.id, "worker-1");

    const row = await system.run.findUniqueOrThrow({ where: { id: queued.id } });
    expect(row).toMatchObject({ status: "cancelled", leaseOwner: null, startedAt: null });
    expect(await system.attempt.count({ where: { runId: queued.id } })).toBe(0);
    expect(notify).toHaveBeenCalledWith(carol.threadId, expect.any(Number));
  });

  it("skips a deactivated owner's routine occurrence and resumes after reactivation", async () => {
    const dana = await person();
    const due = new Date(Date.now() - 1_000);
    const routine = await system.routine.create({
      data: {
        ...dana,
        name: "every minute",
        prompt: "check in",
        crons: ["* * * * *"],
        active: true,
        nextRunAt: due,
      },
    });
    await deactivate(dana);
    enqueue.mockClear();

    await executor().wakeRoutine(routine.id, due.toISOString());

    expect(await system.run.count({ where: { routineId: routine.id } })).toBe(0);
    const skipped = await system.routine.findUniqueOrThrow({ where: { id: routine.id } });
    expect(skipped.active).toBe(true);
    expect(skipped.nextRunAt!.getTime()).toBeGreaterThan(due.getTime());
    // Its next occurrence is still woken on time.
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ name: "routine.wakeup", availableAt: skipped.nextRunAt }),
    );

    await deactivate(dana, null);
    await executor().wakeRoutine(routine.id, skipped.nextRunAt!.toISOString());
    // The next occurrence is in the future, so it waits rather than running now.
    const later = await system.routine.findUniqueOrThrow({ where: { id: routine.id } });
    expect(later.nextRunAt?.getTime()).toBe(skipped.nextRunAt!.getTime());

    await system.routine.update({ where: { id: routine.id }, data: { nextRunAt: due } });
    await executor().wakeRoutine(routine.id, due.toISOString());
    expect(await system.run.count({ where: { routineId: routine.id } })).toBe(1);
  });

  it("keeps a watching routine's checks scheduled while its owner is deactivated", async () => {
    const erin = await person();
    const due = new Date(Date.now() - 1_000);
    const routine = await system.routine.create({
      data: {
        ...erin,
        name: "watch a file",
        prompt: "tell me what changed",
        crons: [],
        watch: { kind: "files", paths: ["notes.md"], everyMinutes: 15 },
        active: true,
        nextRunAt: due,
      },
    });
    await deactivate(erin);

    await executor().wakeRoutine(routine.id, due.toISOString());

    const skipped = await system.routine.findUniqueOrThrow({ where: { id: routine.id } });
    expect(skipped.active).toBe(true);
    expect(skipped.nextRunAt!.getTime()).toBeGreaterThanOrEqual(due.getTime() + 15 * 60_000);
    expect(await system.run.count({ where: { routineId: routine.id } })).toBe(0);
  });
});
