import { randomUUID } from "node:crypto";
import type { BackgroundJob } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import {
  asSystem,
  claimSteering,
  createDb,
  provisionMessagingIdentity,
  runAsSystem,
} from "@rakazo/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ExecutorDeps } from "./executor-deps.js";
import {
  holdRoutineRunForConversation,
  ROUTINE_CONVERSATION_WAIT_MS,
  startRoutineRunsWaitingOn,
} from "./routine-conversation.js";
import { claimRun } from "./run-lifecycle.js";

const url = process.env.DATABASE_URL;
const describePostgres = process.env.VERIFY_DATABASE === "1" && url ? describe : describe.skip;

describePostgres("scheduled runs share a chat one at a time (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let system: PrismaClient;
  let identity: { userId: string; spaceId: string; botId: string; threadId: string };
  let jobs: BackgroundJob[];
  let deps: ExecutorDeps;
  const address = `routine-conversation-${randomUUID()}@rakazo.test`;

  beforeAll(async () => {
    db = createDb(url!);
    system = asSystem(db.prisma);
    const provisioned = await runAsSystem("routine conversation fixture", () =>
      provisionMessagingIdentity(db.prisma, { provider: "email", address }),
    );
    const { userId, spaceId, botId, threadId } = provisioned;
    identity = { userId, spaceId, botId, threadId };
  });
  beforeEach(async () => {
    await system.run.deleteMany({ where: { threadId: identity.threadId } });
    jobs = [];
    deps = {
      prisma: system,
      jobs: { enqueue: async (job: BackgroundJob) => void jobs.push(job) },
      events: { notify: async () => undefined },
    } as unknown as ExecutorDeps;
  });
  afterAll(async () => {
    if (identity) {
      await system.messagingIdentity.deleteMany({ where: { address } });
      await system.organization.deleteMany({ where: { id: identity.spaceId } });
      await system.user.deleteMany({ where: { id: identity.userId } });
    }
    if (db) {
      await db.prisma.$disconnect();
      await db.pool.end();
    }
  });

  async function createRun(data: {
    trigger: string;
    status: string;
    prompt?: string;
    userId?: string;
    startedAt?: Date;
    createdAt?: Date;
    routineId?: string;
  }) {
    const userId = data.userId ?? identity.userId;
    const task = await system.task.create({
      data: { ...identity, userId, prompt: data.prompt ?? "work", status: "queued" },
    });
    return system.run.create({
      data: {
        spaceId: identity.spaceId,
        botId: identity.botId,
        threadId: identity.threadId,
        taskId: task.id,
        userId,
        trigger: data.trigger,
        status: data.status,
        startedAt: data.startedAt,
        createdAt: data.createdAt,
        routineId: data.routineId,
        leaseOwner: data.status === "running" ? "worker" : null,
        leaseFence: data.status === "running" ? 1 : 0,
      },
      include: { routine: { select: { name: true } } },
    });
  }

  async function routine() {
    return system.routine.create({
      data: { ...identity, name: "Digest", prompt: "Send the digest", crons: [] },
    });
  }

  it("starts at once in a quiet chat", async () => {
    const scheduled = await createRun({ trigger: "routine", status: "queued" });

    expect(await claimRun(deps, scheduled, "worker-2")).toBeDefined();
  });

  it("waits for the chat's working run, then starts when that run lets go", async () => {
    const working = await createRun({ trigger: "user", status: "running", startedAt: new Date() });
    const scheduled = await createRun({ trigger: "routine", status: "queued" });

    expect(await claimRun(deps, scheduled, "worker-2")).toBeUndefined();
    await holdRoutineRunForConversation(deps, scheduled);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.availableAt?.getTime()).toBe(
      scheduled.createdAt.getTime() + ROUTINE_CONVERSATION_WAIT_MS,
    );

    // The job publisher records the wake time on the run; this double does not.
    await system.run.update({
      where: { id: scheduled.id },
      data: { wakeAt: jobs[0]!.availableAt },
    });
    jobs = [];
    await system.run.update({ where: { id: working.id }, data: { status: "completed" } });
    await startRoutineRunsWaitingOn(deps, working);
    expect(jobs.map((job) => job.payload)).toEqual([
      expect.objectContaining({ runId: scheduled.id }),
    ]);
    expect(jobs[0]?.availableAt).toBeUndefined();
    await system.run.update({ where: { id: scheduled.id }, data: { wakeAt: null } });
    expect(await claimRun(deps, scheduled, "worker-2")).toBeDefined();
  });

  it("waits behind a run queued ahead of it, but not behind one queued after", async () => {
    const earlier = await createRun({
      trigger: "webhook",
      status: "queued",
      createdAt: new Date(Date.now() - 1_000),
    });
    const scheduled = await createRun({ trigger: "routine", status: "queued" });
    expect(await claimRun(deps, scheduled, "worker-2")).toBeUndefined();

    await system.run.delete({ where: { id: earlier.id } });
    await createRun({ trigger: "webhook", status: "queued" });
    expect(await claimRun(deps, scheduled, "worker-2")).toBeDefined();
  });

  it("hands its task to the person's working run once the wait is over", async () => {
    const { id: routineId } = await routine();
    const working = await createRun({ trigger: "user", status: "running", startedAt: new Date() });
    const scheduled = await createRun({
      trigger: "routine",
      status: "queued",
      prompt: "Send the digest",
      routineId,
      createdAt: new Date(Date.now() - ROUTINE_CONVERSATION_WAIT_MS - 1_000),
    });

    await holdRoutineRunForConversation(deps, scheduled);
    expect(jobs).toEqual([]);

    const ended = await system.run.findUniqueOrThrow({
      where: { id: scheduled.id },
      include: { task: true, sourceMessage: true },
    });
    expect(ended.status).toBe("completed");
    expect(ended.task.status).toBe("completed");
    expect(ended.sourceMessage).toMatchObject({ role: "user", runId: working.id });
    expect(ended.sourceMessage?.blocks).toEqual([
      { kind: "delivery" },
      expect.objectContaining({ kind: "text" }),
    ]);

    const steering = await claimSteering(system, {
      threadId: identity.threadId,
      botId: identity.botId,
      runId: working.id,
      leaseOwner: "worker",
      leaseFence: 1,
      seenIds: [],
    });
    expect(steering).toHaveLength(1);
    expect(steering[0]?.text).toContain('"Digest"');
    expect(steering[0]?.text).toContain("Send the digest");
  });

  it("never hands one person's task to another person's run", async () => {
    await createRun({
      trigger: "user",
      status: "running",
      startedAt: new Date(),
      userId: `${identity.userId}-other`,
    });
    const scheduled = await createRun({
      trigger: "routine",
      status: "queued",
      createdAt: new Date(Date.now() - ROUTINE_CONVERSATION_WAIT_MS - 1_000),
    });

    const before = Date.now();
    await holdRoutineRunForConversation(deps, scheduled);

    expect(await system.run.findUniqueOrThrow({ where: { id: scheduled.id } })).toMatchObject({
      status: "queued",
      sourceMessageId: null,
    });
    expect(jobs[0]?.availableAt?.getTime()).toBeGreaterThanOrEqual(
      before + ROUTINE_CONVERSATION_WAIT_MS,
    );
  });
});
