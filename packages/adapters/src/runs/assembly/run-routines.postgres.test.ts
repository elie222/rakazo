import { createHash, randomUUID } from "node:crypto";
import type { BackgroundJob } from "@rakazo/adapter-kit";
import { deferred } from "@rakazo/core/test-async";
import type { Prisma, PrismaClient } from "@rakazo/db";
import {
  appendEvent,
  asSystem,
  createDb,
  createPendingSteeringRun,
  createThreadEvents,
  provisionMessagingIdentity,
  runAsSystem,
  runAsTenant,
  SpaceDeletionInProgressError,
  sendUserMessage,
  setBotPrimaryRuntimePreference,
} from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { routineTimerNonce } from "../../routines/routine-coalescing.js";
import { deleteSpentRoutine } from "../../routines/routine-end.js";
import { routineGroupThreadId } from "../../routines/routine-thread.js";
import { createRunExecutor } from "../executor/executor.js";
import { pilotRoutineRequest } from "../turn/primary-routine-pilot.js";
import { createJobReconciler } from "../wakeups/job-reconciler.js";

const url = process.env.DATABASE_URL;
const describePostgres = process.env.VERIFY_DATABASE === "1" && url ? describe : describe.skip;

describePostgres("routine tick prompt and model consistency (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let system: PrismaClient;
  let identity: { userId: string; spaceId: string; botId: string; threadId: string };
  const address = `routine-prompt-${randomUUID()}@rakazo.test`;
  beforeAll(async () => {
    db = createDb(url!);
    system = asSystem(db.prisma);
    const provisioned = await runAsSystem("routine prompt fixture", () =>
      provisionMessagingIdentity(db.prisma, { provider: "email", address }),
    );
    const { userId, spaceId, botId, threadId } = provisioned;
    identity = { userId, spaceId, botId, threadId };
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

  it("picks a group thread only while the group is live and the bot is in it", async () => {
    const { userId, spaceId, botId } = identity;
    const other = await system.bot.create({
      data: { spaceId, userId, name: "Other", color: "#000000" },
    });
    const group = await system.chatGroup.create({
      data: {
        spaceId,
        userId,
        name: "Team",
        members: { create: [{ botId }, { botId: other.id }] },
      },
    });
    const thread = await system.thread.create({ data: { spaceId, userId, groupId: group.id } });
    const routine = { spaceId, threadId: thread.id };
    await expect(routineGroupThreadId(system, routine, botId)).resolves.toBe(thread.id);
    await expect(
      routineGroupThreadId(system, { spaceId, threadId: identity.threadId }, botId),
    ).resolves.toBe(identity.threadId);
    await expect(
      routineGroupThreadId(system, { spaceId, threadId: null }, botId),
    ).resolves.toBeNull();
    await system.chatGroupMember.deleteMany({ where: { groupId: group.id, botId } });
    await expect(routineGroupThreadId(system, routine, botId)).resolves.toBeNull();
    await system.chatGroupMember.create({ data: { groupId: group.id, botId } });
    await system.chatGroup.update({ where: { id: group.id }, data: { archivedAt: new Date() } });
    await expect(routineGroupThreadId(system, routine, botId)).resolves.toBeNull();
    await system.chatGroup.delete({ where: { id: group.id } });
    await system.bot.delete({ where: { id: other.id } });
  });

  it.skipIf(process.platform !== "linux")(
    "queues one native run per recurring occurrence and rechecks its authorization",
    async () => {
      const dueAt = new Date(Math.floor((Date.now() - 60_000) / 1000) * 1000);
      const prompt = "Read this local text fixture.";
      const pin = {
        modelProvider: "anthropic",
        modelId: "fixture-model",
        modelCredentialId: "fixture-named-key",
      };
      const savedBot = await system.bot.findUniqueOrThrow({ where: { id: identity.botId } });
      await system.bot.update({ where: { id: identity.botId }, data: pin });
      const routine = await system.routine.create({
        data: {
          ...identity,
          name: "native timer fixture",
          prompt,
          crons: ["0 * * * *"],
          active: true,
          nextRunAt: dueAt,
        },
      });
      vi.stubEnv("PRIMARY_RUNTIME_PILOT_BOT_IDS", identity.botId);
      vi.stubEnv("PRIMARY_RUNTIME_PILOT_LAUNCHER", process.execPath);
      vi.stubEnv(
        "PRIMARY_RUNTIME_PILOT_ROUTINES",
        `${routine.id}:${createHash("sha256").update(prompt).digest("hex")}`,
      );
      try {
        const executor = createRunExecutor({
          prisma: system,
          jobs: {
            enqueue: async () => undefined,
            cancel: async () => undefined,
            close: async () => undefined,
          },
          events: {
            append: (input: Parameters<typeof appendEvent>[1]) => appendEvent(system, input),
            notify: async () => undefined,
          },
        } as unknown as Parameters<typeof createRunExecutor>[0]);

        await Promise.all([
          executor.wakeRoutine(routine.id, dueAt.toISOString()),
          executor.wakeRoutine(routine.id, dueAt.toUTCString()),
        ]);
        // A racing edit can restore the old due time, even after the scheduler advanced it.
        await system.routine.update({ where: { id: routine.id }, data: { nextRunAt: dueAt } });
        await executor.wakeRoutine(routine.id, dueAt.toISOString());
        const runs = await system.run.findMany({ where: { routineId: routine.id } });
        expect(runs).toHaveLength(1);
        const [run] = runs;
        expect(run).toMatchObject({
          ...identity,
          ...pin,
          modelPinned: true,
          primaryRuntime: "claude-agent",
          primaryRuntimeRevision: savedBot.primaryRuntimeRevision,
          clientNonce: routineTimerNonce(routine.id, dueAt.toISOString()),
        });
        const task = await system.task.findUniqueOrThrow({ where: { id: run!.taskId } });
        const request = () =>
          pilotRoutineRequest(
            system,
            { ...run!, primaryRuntime: run!.primaryRuntime! },
            task.prompt,
            { provider: pin.modelProvider, id: pin.modelId, connectionId: pin.modelCredentialId },
            undefined,
            [],
          );
        await expect(request()).resolves.toMatchObject({ prompt, history: [], tools: [] });
        await system.routine.update({
          where: { id: routine.id },
          data: { endsAt: new Date(dueAt.getTime() - 1) },
        });
        await expect(request()).rejects.toThrow("no longer authorized");
        await system.routine.update({
          where: { id: routine.id },
          data: { endsAt: null, active: false },
        });
        await expect(request()).rejects.toThrow("no longer authorized");
        // Restore the eligible schedule, then change only the saved runtime
        // selection twice. The real worker must fail before opening a model.
        await system.routine.update({ where: { id: routine.id }, data: { active: true } });
        const choose = (preference: string, expectedRevision: number) =>
          runAsTenant(identity, () =>
            setBotPrimaryRuntimePreference(db.prisma, {
              ...identity,
              preference,
              expectedRevision,
            }),
          );
        await expect(choose("pi", savedBot.primaryRuntimeRevision)).resolves.toHaveProperty(
          "status",
          "changed",
        );
        await expect(
          choose("claude-agent", savedBot.primaryRuntimeRevision + 1),
        ).resolves.toHaveProperty("status", "changed");
        const runPi = vi.fn();
        const readSecret = vi.fn(async () => null);
        const worker = createRunExecutor({
          prisma: db.prisma,
          secrets: [],
          secretStore: { get: readSecret },
          memoryProviders: { resolve: async () => null },
          jobs: { enqueue: vi.fn(), cancel: vi.fn(), close: vi.fn() },
          events: createThreadEvents(db.prisma),
          runtime: { run: runPi },
        } as unknown as Parameters<typeof createRunExecutor>[0]);
        if (!run) throw new Error("fixture did not queue the native routine");
        await runAsTenant(identity, () => worker.continueRun(run.id, "routine-fixture-worker"));
        await expect(
          system.run.findUniqueOrThrow({ where: { id: run.id } }),
        ).resolves.toHaveProperty("status", "failed");
        await expect(
          system.event.findFirstOrThrow({ where: { runId: run.id, type: "run.failed" } }),
        ).resolves.toMatchObject({ payload: { error: expect.stringContaining("has changed") } });
        expect(runPi).not.toHaveBeenCalled();
        expect(readSecret).not.toHaveBeenCalled();
      } finally {
        vi.unstubAllEnvs();
        await system.run.deleteMany({ where: { routineId: routine.id } });
        // Teardown deletes the dedicated test Space and any remaining tasks.
        await system.routine.deleteMany({ where: { id: routine.id } });
        await system.bot.update({
          where: { id: identity.botId },
          data: {
            primaryRuntimePreference: savedBot.primaryRuntimePreference,
            primaryRuntimeRevision: savedBot.primaryRuntimeRevision,
            modelProvider: savedBot.modelProvider,
            modelId: savedBot.modelId,
            modelCredentialId: savedBot.modelCredentialId,
          },
        });
      }
    },
  );

  it("records a refused final occurrence once and keeps it after routine cleanup", async () => {
    const dueAt = new Date(Math.floor((Date.now() - 10_000) / 1000) * 1000);
    const routine = await system.routine.create({
      data: {
        ...identity,
        name: "Closing report",
        prompt: "Private synthetic prompt",
        crons: ["0 9 * * *"],
        active: true,
        nextRunAt: dueAt,
        endsAt: dueAt,
      },
    });
    const runtime = vi.fn();
    const enqueue = vi.fn();
    const events = createThreadEvents(db.prisma);
    const executor = createRunExecutor({
      prisma: db.prisma,
      secrets: [],
      jobs: { enqueue, cancel: vi.fn(), close: vi.fn() },
      events,
      runtime: { run: runtime },
    } as unknown as Parameters<typeof createRunExecutor>[0]);
    const bot = await system.bot.findUniqueOrThrow({ where: { id: identity.botId } });
    try {
      await runAsTenant(identity, () =>
        setBotPrimaryRuntimePreference(db.prisma, {
          ...identity,
          preference: "claude-agent",
          expectedRevision: bot.primaryRuntimeRevision,
        }),
      );
      const wake = (at: string) =>
        runAsTenant(identity, () => executor.wakeRoutine(routine.id, at));
      await Promise.all([wake(dueAt.toISOString()), wake(dueAt.toUTCString())]);
      await wake(dueAt.toISOString());
      expect(await system.routine.findUnique({ where: { id: routine.id } })).toBeNull();
      const runs = await system.run.findMany({
        where: {
          spaceId: identity.spaceId,
          clientNonce: routineTimerNonce(routine.id, dueAt.toISOString()),
        },
      });
      expect(runs).toHaveLength(1);
      const [failed] = runs;
      expect(failed).toMatchObject({ status: "failed", routineId: null, startedAt: null });
      expect(failed?.error).toContain(`${dueAt.toISOString()}: Closing report`);
      const failures = await runAsTenant(identity, () =>
        db.prisma.event.findMany({
          where: { threadId: identity.threadId, runId: failed!.id, type: "run.failed" },
        }),
      );
      expect(failures).toHaveLength(1);
      expect(failures[0]?.payload).toEqual({
        error: expect.stringContaining("No model ran"),
        routineId: routine.id,
        routineName: "Closing report",
        scheduledFor: dueAt.toISOString(),
      });
      expect(runtime).not.toHaveBeenCalled();
      expect(enqueue).not.toHaveBeenCalled();
    } finally {
      await system.bot.update({
        where: { id: identity.botId },
        data: {
          primaryRuntimePreference: bot.primaryRuntimePreference,
          primaryRuntimeRevision: bot.primaryRuntimeRevision,
        },
      });
    }
  });

  it("does not replay a refused occurrence through Pi after the owner changes runtime", async () => {
    const dueAt = new Date(Math.floor((Date.now() - 60_000) / 1000) * 1000);
    const routine = await system.routine.create({
      data: {
        ...identity,
        name: "Daily report",
        prompt: "Synthetic report",
        crons: ["0 9 * * *"],
        active: true,
        nextRunAt: dueAt,
      },
    });
    const enqueue = vi.fn();
    const executor = createRunExecutor({
      prisma: db.prisma,
      jobs: { enqueue, cancel: vi.fn(), close: vi.fn() },
      events: createThreadEvents(db.prisma),
    } as unknown as Parameters<typeof createRunExecutor>[0]);
    const actor = identity;
    const bot = await system.bot.findUniqueOrThrow({ where: { id: actor.botId } });
    const choose = (preference: string, expectedRevision: number) =>
      runAsTenant(actor, () =>
        setBotPrimaryRuntimePreference(db.prisma, {
          ...actor,
          preference,
          expectedRevision,
        }),
      );
    const wake = (at: string) => runAsTenant(actor, () => executor.wakeRoutine(routine.id, at));
    try {
      vi.stubEnv("PRIMARY_RUNTIME_PILOT_BOT_IDS", actor.botId);
      vi.stubEnv("PRIMARY_RUNTIME_PILOT_ROUTINES", `${routine.id}:bad-digest`);
      await choose("claude-agent", bot.primaryRuntimeRevision);
      await wake(dueAt.toUTCString());
      const failed = await system.run.findFirstOrThrow({ where: { routineId: routine.id } });
      expect(failed.status).toBe("failed");
      await system.routine.update({
        where: { id: routine.id },
        data: { nextRunAt: new Date(Date.now() + 2 * 60 * 60_000) },
      });
      await runAsTenant(actor, () => executor.retryRoutineRun(failed.id));
      expect(await system.run.count({ where: { routineId: routine.id } })).toBe(1);
      await choose("pi", bot.primaryRuntimeRevision + 1);
      await system.routine.update({ where: { id: routine.id }, data: { nextRunAt: dueAt } });
      await wake(dueAt.toISOString());
      expect(await system.run.count({ where: { routineId: routine.id } })).toBe(1);

      const later = new Date(dueAt.getTime() + 1000);
      await system.routine.update({ where: { id: routine.id }, data: { nextRunAt: later } });
      await wake(later.toISOString());
      const ordinary = await system.run.findFirstOrThrow({
        where: { routineId: routine.id, status: "queued" },
      });
      expect(ordinary).toMatchObject({
        primaryRuntime: null,
        clientNonce: routineTimerNonce(routine.id, later.toISOString()),
      });
      expect(enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "run.continue",
          payload: { runId: ordinary.id },
        }),
      );
    } finally {
      vi.unstubAllEnvs();
      await system.bot.update({
        where: { id: actor.botId },
        data: {
          primaryRuntimePreference: bot.primaryRuntimePreference,
          primaryRuntimeRevision: bot.primaryRuntimeRevision,
        },
      });
    }
  });

  it("runs the prompt that was saved with the model it claims", async () => {
    const dueAt = new Date(Date.now() - 60_000);
    const routine = await system.routine.create({
      data: {
        ...identity,
        name: "report",
        prompt: "OLD recipient",
        crons: ["* * * * *"],
        active: true,
        nextRunAt: dueAt,
        modelProvider: "prov-a",
        modelId: "model-A",
      },
    });
    // The editor changes the prompt and the model but leaves nextRunAt alone,
    // so the tick's claim still matches; it must not pair the old prompt with
    // the new model. The edit lands right before the claim, after the tick
    // has already read the routine.
    const realTransaction = system.$transaction.bind(system);
    let editBeforeClaim: (() => Promise<unknown>) | null = async () => {
      await system.routine.update({
        where: { id: routine.id },
        data: { prompt: "CORRECTED recipient", modelProvider: "prov-b", modelId: "model-B" },
      });
    };
    const hooked = Object.create(system) as PrismaClient;
    hooked.$transaction = ((
      fn: Parameters<typeof realTransaction>[0],
      options?: Parameters<typeof realTransaction>[1],
    ) => {
      const edit = editBeforeClaim;
      editBeforeClaim = null;
      return (edit ? edit() : Promise.resolve()).then(() => realTransaction(fn, options));
    }) as PrismaClient["$transaction"];
    const executor = createRunExecutor({
      prisma: hooked,
      jobs: {
        enqueue: async () => undefined,
        cancel: async () => undefined,
        close: async () => undefined,
      },
      events: {
        append: (input: Parameters<typeof appendEvent>[1]) => appendEvent(system, input),
        notify: async () => undefined,
      },
    } as unknown as Parameters<typeof createRunExecutor>[0]);

    await executor.wakeRoutine(routine.id, dueAt.toISOString());

    const run = await system.run.findFirstOrThrow({ where: { routineId: routine.id } });
    const task = await system.task.findUniqueOrThrow({ where: { id: run.taskId } });
    expect(task.prompt).toContain("CORRECTED");
    expect(run).toMatchObject({ modelProvider: "prov-b", modelId: "model-B", modelPinned: true });
  });

  it("deletes only a spent routine and keeps its run history", async () => {
    const spent = { crons: ["@once"], active: false, nextRunAt: null, lastRunAt: new Date() };
    const create = (data: Partial<Prisma.RoutineUncheckedCreateInput>) =>
      system.routine.create({
        data: { ...identity, name: "reminder", prompt: "remind me", ...spent, ...data },
      });
    const [done, rescheduled, recurring, webhook, busy, paused, ended, pausedPastEnd] =
      await Promise.all([
        create({}),
        create({ active: true, nextRunAt: new Date(Date.now() + 60 * 60_000) }),
        create({ crons: ["0 9 * * *"] }),
        create({ webhookEnabled: true }),
        create({}),
        create({ lastRunAt: null }),
        create({ crons: ["0 9 * * *"], active: true, endsAt: new Date(Date.now() - 60_000) }),
        create({ crons: ["0 9 * * *"], endsAt: new Date(Date.now() - 60_000) }),
      ]);
    const task = await system.task.create({
      data: { ...identity, prompt: "remind me", status: "completed" },
    });
    const runFor = (routineId: string, status: string) =>
      system.run.create({
        data: { ...identity, taskId: task.id, status, trigger: "routine", routineId },
      });
    const finished = await runFor(done.id, "completed");
    await runFor(busy.id, "running");
    await runFor(paused.id, "completed");

    const published: string[] = [];
    const deps = {
      prisma: system,
      events: {
        notify: async () => undefined,
        publishSpaceChange: async (spaceId: string, kind: string) => {
          published.push(`${spaceId}:${kind}`);
        },
      },
    };
    const all = [done, rescheduled, recurring, webhook, busy, paused, ended, pausedPastEnd];
    for (const routine of all)
      await deleteSpentRoutine(deps, { ...identity, routineId: routine.id });

    const left = await system.routine.findMany({
      where: { id: { in: all.map((routine) => routine.id) } },
      select: { id: true },
    });
    expect(left.map((row) => row.id).sort()).toEqual(
      [rescheduled.id, recurring.id, webhook.id, busy.id, paused.id, pausedPastEnd.id].sort(),
    );
    expect(published).toEqual([`${identity.spaceId}:routines`, `${identity.spaceId}:routines`]);
    await expect(
      system.run.findUniqueOrThrow({ where: { id: finished.id }, select: { routineId: true } }),
    ).resolves.toEqual({ routineId: null });
  });

  it("runs no routine in a Space that is being deleted", async () => {
    const dueAt = new Date(Date.now() - 60_000);
    const routine = await system.routine.create({
      data: {
        ...identity,
        name: "report",
        prompt: "report",
        crons: ["* * * * *"],
        active: true,
        nextRunAt: dueAt,
      },
    });
    const executor = createRunExecutor({
      prisma: system,
      jobs: {
        enqueue: async () => undefined,
        cancel: async () => undefined,
        close: async () => undefined,
      },
      events: {
        append: (input: Parameters<typeof appendEvent>[1]) => appendEvent(system, input),
        notify: async () => undefined,
      },
    } as unknown as Parameters<typeof createRunExecutor>[0]);
    await system.space.update({
      where: { id: identity.spaceId },
      data: {
        deletingAt: new Date(),
        deletionClaimId: `organization-deletion:${identity.spaceId}`,
      },
    });
    try {
      await executor.wakeRoutine(routine.id, dueAt.toISOString());
    } finally {
      await system.space.update({
        where: { id: identity.spaceId },
        data: { deletingAt: null, deletionClaimId: null },
      });
    }

    await expect(system.run.count({ where: { routineId: routine.id } })).resolves.toBe(0);
  });

  it("neither retries a routine nor takes a message in a Space that is being deleted", async () => {
    const routine = await system.routine.create({
      data: {
        ...identity,
        name: "report",
        prompt: "report",
        crons: ["0 9 * * *"],
        active: true,
        nextRunAt: new Date(Date.now() + 24 * 60 * 60_000),
      },
    });
    const task = await system.task.create({
      data: { ...identity, prompt: "report", status: "failed" },
    });
    const failed = await system.run.create({
      data: {
        ...identity,
        taskId: task.id,
        status: "failed",
        trigger: "routine",
        routineId: routine.id,
      },
    });
    const enqueued: string[] = [];
    const executor = createRunExecutor({
      prisma: system,
      jobs: {
        enqueue: async (job: { name: string }) => {
          enqueued.push(job.name);
        },
        cancel: async () => undefined,
        close: async () => undefined,
      },
      events: {
        append: (input: Parameters<typeof appendEvent>[1]) => appendEvent(system, input),
        notify: async () => undefined,
      },
    } as unknown as Parameters<typeof createRunExecutor>[0]);
    await system.space.update({
      where: { id: identity.spaceId },
      data: {
        deletingAt: new Date(),
        deletionClaimId: `organization-deletion:${identity.spaceId}:attempt`,
      },
    });
    let sent: Promise<unknown>;
    try {
      await executor.retryRoutineRun(failed.id);
      sent = sendUserMessage(system, {
        spaceId: identity.spaceId,
        threadId: identity.threadId,
        botId: identity.botId,
        userId: identity.userId,
        blocks: [{ kind: "text", text: "hello" }],
        prompt: "hello",
        trigger: "webhook",
      });
      await sent.catch(() => undefined);
    } finally {
      await system.space.update({
        where: { id: identity.spaceId },
        data: { deletingAt: null, deletionClaimId: null },
      });
    }

    expect({
      retries: await system.run.count({ where: { retryOfRunId: failed.id } }),
      messageRuns: await system.run.count({
        where: { threadId: identity.threadId, trigger: "webhook" },
      }),
      enqueued,
    }).toEqual({ retries: 0, messageRuns: 0, enqueued: [] });
    await expect(sent).rejects.toBeInstanceOf(SpaceDeletionInProgressError);
  });

  function testExecutor(enqueued: string[] = []) {
    return createRunExecutor({
      prisma: system,
      jobs: {
        enqueue: async (job: { name: string }) => {
          enqueued.push(job.name);
        },
        cancel: async () => undefined,
        close: async () => undefined,
      },
      events: {
        append: (input: Parameters<typeof appendEvent>[1]) => appendEvent(system, input),
        notify: async () => undefined,
      },
    } as unknown as Parameters<typeof createRunExecutor>[0]);
  }

  async function queuedRun(trigger: string) {
    const task = await system.task.create({
      data: { ...identity, prompt: trigger, status: "queued" },
    });
    return system.run.create({
      data: { ...identity, taskId: task.id, status: "queued", trigger },
    });
  }

  const claimed = {
    deletingAt: new Date(),
    deletionClaimId: `organization-deletion:${randomUUID()}:test`,
  };
  async function settle() {
    await system.space.update({
      where: { id: identity.spaceId },
      data: { deletingAt: null, deletionClaimId: null },
    });
    await system.run.updateMany({
      where: { threadId: identity.threadId, status: { in: ["queued", "leased", "running"] } },
      data: { status: "cancelled" },
    });
    await system.steeringMessage.deleteMany({ where: { botId: identity.botId } });
  }

  /**
   * Runs `work` while a deletion claim of the Space is written under the Space's lock but not yet
   * committed, the way claiming a Space for deletion does; the claim commits once `work` has had
   * time to read the Space.
   */
  async function duringUncommittedClaim<T>(work: () => Promise<T>) {
    const lockTaken = deferred();
    const released = deferred();
    const claim = system.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${identity.spaceId}, 0))::text AS "lock"`;
        await tx.space.update({ where: { id: identity.spaceId }, data: claimed });
        lockTaken.resolve();
        await released.promise;
      },
      { timeout: 30_000 },
    );
    await lockTaken.promise;
    const outcome = work().then(
      () => null,
      (error: unknown) => error,
    );
    await new Promise((done) => setTimeout(done, 300));
    released.resolve();
    await claim;
    return outcome;
  }

  /** Opens a transaction that runs `hold`, then waits until `release` is called to commit. */
  function heldTransaction(hold: (tx: Prisma.TransactionClient) => Promise<unknown>) {
    const holding = deferred();
    const released = deferred();
    const committed = system.$transaction(
      async (tx) => {
        await hold(tx);
        holding.resolve();
        await released.promise;
      },
      { timeout: 30_000 },
    );
    return { holding: holding.promise, release: released.resolve, committed };
  }

  const pause = () => new Promise((done) => setTimeout(done, 300));

  it("holds a follow-up while the Space is being deleted and recovers it when that is called off", async () => {
    // Earlier tests leave queued runs in the thread, and any live run holds the follow-up.
    await settle();
    const busy = await queuedRun("routine");
    try {
      // A webhook delivery waits behind the routine turn as steering.
      await sendUserMessage(system, {
        ...identity,
        blocks: [{ kind: "text", text: "held" }],
        prompt: "held",
        trigger: "webhook",
      });
      await system.space.update({ where: { id: identity.spaceId }, data: claimed });
      // The routine turn finishes while the organization deletion waits on billing.
      await system.run.update({ where: { id: busy.id }, data: { status: "cancelled" } });
      const followUp = await system.$transaction((tx) => createPendingSteeringRun(tx, identity));
      if (followUp) await testExecutor().continueRun(followUp, "worker-deleting");
      const held = followUp
        ? (await system.run.findUniqueOrThrow({ where: { id: followUp } })).status
        : null;

      // Billing cancellation fails and releases the claim; recovery starts the follow-up.
      await system.space.update({
        where: { id: identity.spaceId },
        data: { deletingAt: null, deletionClaimId: null },
      });
      const published: BackgroundJob[] = [];
      const jobs = {
        enqueue: async (job: BackgroundJob) => {
          published.push(job);
        },
        enqueueIn: async () => undefined,
        enqueueManyIn: async () => undefined,
        cancelIn: async () => undefined,
        cancel: async () => undefined,
        close: async () => undefined,
      };
      await runAsSystem("reconcile jobs", () =>
        createJobReconciler({ prisma: db.prisma, jobs }, { maxPagesPerPass: 1000 }).reconcileOnce(),
      );

      expect({
        held,
        recovered: published.some(
          (job) =>
            job.name === "run.continue" && (job.payload as { runId?: string }).runId === followUp,
        ),
      }).toEqual({ held: "queued", recovered: true });
    } finally {
      await settle();
    }
  });

  it("starts no run when the deletion claim commits while the lease waits for the run row", async () => {
    await settle();
    const queued = await queuedRun("user");
    try {
      const row = heldTransaction(
        (tx) => tx.$queryRaw`SELECT id FROM runs WHERE id = ${queued.id} FOR UPDATE`,
      );
      await row.holding;
      const claim = heldTransaction(async (tx) => {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${identity.spaceId}, 0))::text AS "lock"`;
        await tx.space.update({ where: { id: identity.spaceId }, data: claimed });
      });
      await claim.holding;
      const started = testExecutor()
        .continueRun(queued.id, "worker-racing")
        .catch(() => undefined);
      await pause();
      claim.release();
      await claim.committed;
      await pause();
      row.release();
      await row.committed;
      await started;

      expect((await system.run.findUniqueOrThrow({ where: { id: queued.id } })).status).toBe(
        "queued",
      );
    } finally {
      await settle();
    }
  });

  it("keeps a transcript message that starts no run in a Space that is being deleted", async () => {
    await settle();
    try {
      await system.space.update({ where: { id: identity.spaceId }, data: claimed });
      await expect(
        sendUserMessage(system, {
          ...identity,
          blocks: [{ kind: "text", text: "mirrored" }],
          prompt: "mirrored",
          trigger: "messaging",
          createRun: false,
        }),
      ).resolves.toMatchObject({ runId: null });
    } finally {
      await settle();
    }
  });

  it("refuses a message when the deletion claim commits while the send is under way", async () => {
    try {
      const outcome = await duringUncommittedClaim(() =>
        sendUserMessage(system, {
          ...identity,
          blocks: [{ kind: "text", text: "racing" }],
          prompt: "racing",
          trigger: "webhook",
        }),
      );
      expect(outcome).toBeInstanceOf(SpaceDeletionInProgressError);
    } finally {
      await settle();
    }
  });

  it("neither retries nor wakes a routine when the deletion claim commits meanwhile", async () => {
    const routine = await system.routine.create({
      data: {
        ...identity,
        name: "report",
        prompt: "report",
        crons: ["0 9 * * *"],
        active: true,
        nextRunAt: new Date(Date.now() + 24 * 60 * 60_000),
      },
    });
    const task = await system.task.create({
      data: { ...identity, prompt: "report", status: "failed" },
    });
    const failed = await system.run.create({
      data: {
        ...identity,
        taskId: task.id,
        status: "failed",
        trigger: "routine",
        routineId: routine.id,
      },
    });
    const enqueued: string[] = [];
    try {
      await duringUncommittedClaim(() => testExecutor(enqueued).retryRoutineRun(failed.id));
      await settle();
      const dueAt = new Date(Date.now() - 60_000);
      await system.routine.update({ where: { id: routine.id }, data: { nextRunAt: dueAt } });
      await duringUncommittedClaim(() =>
        testExecutor(enqueued).wakeRoutine(routine.id, dueAt.toISOString()),
      );

      expect({
        runs: await system.run.count({
          where: { routineId: routine.id, id: { not: failed.id } },
        }),
        enqueued,
      }).toEqual({ runs: 0, enqueued: [] });
    } finally {
      await settle();
    }
  });
});
