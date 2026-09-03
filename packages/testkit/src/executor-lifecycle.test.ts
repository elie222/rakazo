import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { approvalEffectKey } from "@rakazo/core/node/approval-effect-key";
import { createThreadEvents } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.WAKEUP_DRIVER = "memory";
process.env.SANDBOX_PROVIDER = "fake";
process.env.AGENT_RUNTIME = "scripted";

const hasDb = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const describeIntegration = hasDb ? describe : describe.skip;

describeIntegration("run executor lifecycle", () => {
  let handles: Awaited<ReturnType<typeof import("../../../apps/api/src/app.ts")["createApp"]>>;
  const dataDir = mkdtempSync(path.join(tmpdir(), "rakazo-executor-lifecycle-"));
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  beforeAll(async () => {
    const { createApp } = await import("../../../apps/api/src/app.ts");
    handles = await createApp({
      databaseUrl: process.env.DATABASE_URL!,
      dataDir,
      sandboxProvider: "fake",
      agentRuntime: "scripted",
      wakeupDriver: "memory",
      defaultProvider: "scripted",
      defaultModel: "scripted",
    });
  });

  afterAll(async () => {
    await handles?.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("allows only one worker to claim a queued run", async () => {
    const seeded = await seedRun("concurrent", "write a file that says one-claim");

    await Promise.all([
      handles.executor.continueRun(seeded.run.id, "worker-a"),
      handles.executor.continueRun(seeded.run.id, "worker-b"),
    ]);

    const [run, attempts] = await Promise.all([
      handles.prisma.run.findUniqueOrThrow({ where: { id: seeded.run.id } }),
      handles.prisma.attempt.findMany({ where: { runId: seeded.run.id } }),
    ]);
    expect(run.status).toBe("completed");
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ fence: 1, status: "completed" });
  });

  it("reclaims an expired running lease with a higher fence", async () => {
    const seeded = await seedRun("expired", "write a file that says recovered", {
      status: "running",
      leaseOwner: "dead-worker",
      leaseFence: 7,
      leaseExpiresAt: new Date(Date.now() - 60_000),
      startedAt: new Date(Date.now() - 120_000),
    });

    await handles.executor.continueRun(seeded.run.id, "recovery-worker");

    const [run, attempts] = await Promise.all([
      handles.prisma.run.findUniqueOrThrow({ where: { id: seeded.run.id } }),
      handles.prisma.attempt.findMany({ where: { runId: seeded.run.id } }),
    ]);
    expect(run.status).toBe("completed");
    expect(run.leaseFence).toBe(8);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ fence: 8, status: "completed" });
  });

  it.each(["completed", "cancelled"])("does not rerun a %s run", async (status) => {
    const seeded = await seedRun(`terminal-${status}`, "write a destination record", {
      status,
      completedAt: new Date(),
    });
    const recordsBefore = handles.connector.records.length;

    await handles.executor.continueRun(seeded.run.id, "late-worker");

    expect(await handles.prisma.attempt.count({ where: { runId: seeded.run.id } })).toBe(0);
    expect(handles.connector.records).toHaveLength(recordsBefore);
    await expect(
      handles.prisma.run.findUniqueOrThrow({ where: { id: seeded.run.id } }),
    ).resolves.toMatchObject({ status });
  });

  it("records an uncertain result without replaying an interrupted external effect", async () => {
    const prompt = "write this to the destination crm as a note";
    const seeded = await seedRun("uncertain-effect", prompt);
    const args = { collection: "notes", title: "Rakazo result", body: prompt };
    const executionId = approvalEffectKey(seeded.run.id, "destination.write", args);
    await handles.prisma.externalEffect.create({
      data: {
        spaceId: seeded.me.spaceId,
        runId: seeded.run.id,
        kind: "destination.write",
        idempotencyKey: executionId,
        status: "executing",
        request: args,
      },
    });
    const recordsBefore = handles.connector.records.length;

    await handles.executor.continueRun(seeded.run.id, "retry-worker");

    const [run, attempt, effect] = await Promise.all([
      handles.prisma.run.findUniqueOrThrow({ where: { id: seeded.run.id } }),
      handles.prisma.attempt.findFirstOrThrow({ where: { runId: seeded.run.id } }),
      handles.prisma.externalEffect.findUniqueOrThrow({ where: { idempotencyKey: executionId } }),
    ]);
    expect(run).toMatchObject({ status: "completed", error: null });
    expect(attempt).toMatchObject({ status: "completed", error: null });
    expect(effect).toMatchObject({
      status: "uncertain",
      result: expect.objectContaining({ uncertain: true }),
    });
    expect(handles.connector.records).toHaveLength(recordsBefore);
    expect(
      await handles.prisma.event.count({
        where: { runId: seeded.run.id, type: "effect.reconciled" },
      }),
    ).toBe(1);
  });

  it("recreates the approval pause when an intended effect was interrupted before the card", async () => {
    const prompt = "write this to the destination crm as a note";
    const seeded = await seedRun("interrupted-before-approval", prompt);
    const args = { collection: "notes", title: "Rakazo result", body: prompt };
    const executionId = approvalEffectKey(seeded.run.id, "destination.write", args);
    const effect = await handles.prisma.externalEffect.create({
      data: {
        spaceId: seeded.me.spaceId,
        runId: seeded.run.id,
        kind: "destination.write",
        idempotencyKey: executionId,
        status: "intended",
        request: args,
      },
    });
    await handles.prisma.actionApprovalRule.create({
      data: {
        spaceId: seeded.me.spaceId,
        createdByUserId: seeded.me.userId,
        effect: "require_approval",
        matchKind: "tool",
        matchValue: "destination.write",
      },
    });
    const recordsBefore = handles.connector.records.length;

    await handles.executor.continueRun(seeded.run.id, "retry-worker");

    const [run, attempt, message] = await Promise.all([
      handles.prisma.run.findUniqueOrThrow({ where: { id: seeded.run.id } }),
      handles.prisma.attempt.findFirstOrThrow({ where: { runId: seeded.run.id } }),
      handles.prisma.message.findFirstOrThrow({
        where: { runId: seeded.run.id, role: "bot" },
        orderBy: { seq: "desc" },
      }),
    ]);
    expect(run.status).toBe("waiting_input");
    expect(attempt.status).toBe("waiting_input");
    expect(message.blocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "ask", approvalEffectId: effect.id, status: "pending" }),
      ]),
    );
    expect(handles.connector.records).toHaveLength(recordsBefore);
  });

  it("fences concurrent terminal commits so only one final message is durable", async () => {
    const seeded = await seedRun("terminal-fence", "finish once", {
      status: "running",
      leaseOwner: "terminal-worker",
      leaseFence: 4,
      leaseExpiresAt: new Date(Date.now() + 60_000),
      startedAt: new Date(),
    });
    const attempt = await handles.prisma.attempt.create({
      data: { runId: seeded.run.id, fence: 4, status: "running" },
    });
    const events = createThreadEvents(handles.prisma);
    const input = {
      spaceId: seeded.me.spaceId,
      threadId: seeded.thread.id,
      botId: seeded.bot.id,
      runId: seeded.run.id,
      taskId: seeded.task.id,
      attemptId: attempt.id,
      leaseOwner: "terminal-worker",
      leaseFence: 4,
      outcome: "completed" as const,
      blocks: [{ kind: "text" as const, text: "the one final answer" }],
    };

    const results = await Promise.all([events.finalizeRun(input), events.finalizeRun(input)]);

    expect(results.filter((result) => result === false)).toHaveLength(1);
    expect(results.filter(Boolean)).toEqual([{ continuationRunId: null }]);
    const [run, storedAttempt, task, messages, terminalEvents] = await Promise.all([
      handles.prisma.run.findUniqueOrThrow({ where: { id: seeded.run.id } }),
      handles.prisma.attempt.findUniqueOrThrow({ where: { id: attempt.id } }),
      handles.prisma.task.findUniqueOrThrow({ where: { id: seeded.task.id } }),
      handles.prisma.message.findMany({ where: { runId: seeded.run.id } }),
      handles.prisma.event.findMany({
        where: {
          runId: seeded.run.id,
          type: { in: ["thread.message.created", "run.completed"] },
        },
        orderBy: { seq: "asc" },
      }),
    ]);
    expect(run).toMatchObject({ status: "completed", leaseOwner: null, leaseExpiresAt: null });
    expect(storedAttempt.status).toBe("completed");
    expect(task.status).toBe("completed");
    expect(messages).toHaveLength(1);
    expect(terminalEvents.map((event) => event.type)).toEqual([
      "thread.message.created",
      "run.completed",
    ]);
  });

  it("rolls back every terminal write when the atomic commit fails", async () => {
    const seeded = await seedRun("terminal-rollback", "do not partially finish", {
      status: "running",
      leaseOwner: "rollback-worker",
      leaseFence: 9,
      leaseExpiresAt: new Date(Date.now() + 60_000),
      startedAt: new Date(),
    });
    const attempt = await handles.prisma.attempt.create({
      data: { runId: seeded.run.id, fence: 9, status: "running" },
    });
    const events = createThreadEvents(handles.prisma);

    await expect(
      events.finalizeRun({
        spaceId: seeded.me.spaceId,
        threadId: seeded.thread.id,
        botId: seeded.bot.id,
        runId: seeded.run.id,
        taskId: seeded.task.id,
        attemptId: "missing-attempt",
        leaseOwner: "rollback-worker",
        leaseFence: 9,
        outcome: "completed",
        blocks: [{ kind: "text", text: "must roll back" }],
      }),
    ).rejects.toThrow();

    await expect(
      handles.prisma.run.findUniqueOrThrow({ where: { id: seeded.run.id } }),
    ).resolves.toMatchObject({ status: "running", leaseOwner: "rollback-worker" });
    await expect(
      handles.prisma.attempt.findUniqueOrThrow({ where: { id: attempt.id } }),
    ).resolves.toMatchObject({ status: "running", finishedAt: null });
    await expect(
      handles.prisma.task.findUniqueOrThrow({ where: { id: seeded.task.id } }),
    ).resolves.toMatchObject({ status: "queued" });
    expect(await handles.prisma.message.count({ where: { runId: seeded.run.id } })).toBe(0);
    expect(await handles.prisma.event.count({ where: { runId: seeded.run.id } })).toBe(0);
  });

  it("coalesces steering that races finalization into one durable continuation", async () => {
    const seeded = await seedRun("steering-race", "start the analysis", {
      status: "running",
      leaseOwner: "steering-worker",
      leaseFence: 3,
      leaseExpiresAt: new Date(Date.now() + 60_000),
      startedAt: new Date(),
    });
    const attempt = await handles.prisma.attempt.create({
      data: { runId: seeded.run.id, fence: 3, status: "running" },
    });
    const events = createThreadEvents(handles.prisma);
    for (const text of ["Use the revised data.", "Keep it concise."]) {
      await events.sendUserMessage({
        spaceId: seeded.me.spaceId,
        threadId: seeded.thread.id,
        botId: seeded.bot.id,
        userId: seeded.me.userId,
        blocks: [{ kind: "text", text }],
        prompt: text,
        trigger: "follow_up",
      });
    }

    const finalized = await events.finalizeRun({
      spaceId: seeded.me.spaceId,
      threadId: seeded.thread.id,
      botId: seeded.bot.id,
      runId: seeded.run.id,
      taskId: seeded.task.id,
      attemptId: attempt.id,
      leaseOwner: "steering-worker",
      leaseFence: 3,
      outcome: "completed",
      blocks: [{ kind: "text", text: "Initial answer" }],
    });

    if (!finalized) throw new Error("Expected the active run to finalize");
    const continuationRunId = finalized.continuationRunId;
    expect(continuationRunId).toEqual(expect.any(String));
    const [continuation, steering] = await Promise.all([
      handles.prisma.run.findUniqueOrThrow({
        where: { id: continuationRunId! },
        include: { task: true },
      }),
      handles.prisma.steeringMessage.findMany({
        where: { botId: seeded.bot.id },
        orderBy: { message: { seq: "asc" } },
      }),
    ]);
    expect(continuation).toMatchObject({ status: "queued", trigger: "follow_up" });
    expect(continuation.task.prompt).toBe("Respond to the user's steering context.");
    expect(steering).toHaveLength(2);
    expect(steering).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ runId: continuationRunId, claimedAt: null }),
        expect.objectContaining({ runId: continuationRunId, claimedAt: null }),
      ]),
    );
    const userMessages = await handles.prisma.message.findMany({
      where: { threadId: seeded.thread.id, role: "user" },
      orderBy: { seq: "asc" },
    });
    expect(userMessages).toHaveLength(2);
    expect(userMessages[0]!.seq).toBeLessThan(userMessages[1]!.seq);
  });

  it("requeues steering claimed by a failed attempt without duplicating it", async () => {
    const seeded = await seedRun("steering-failure", "start the analysis", {
      status: "running",
      leaseOwner: "failure-worker",
      leaseFence: 4,
      leaseExpiresAt: new Date(Date.now() + 60_000),
      startedAt: new Date(),
    });
    const attempt = await handles.prisma.attempt.create({
      data: { runId: seeded.run.id, fence: 4, status: "running" },
    });
    const events = createThreadEvents(handles.prisma);
    await events.sendUserMessage({
      spaceId: seeded.me.spaceId,
      threadId: seeded.thread.id,
      botId: seeded.bot.id,
      userId: seeded.me.userId,
      blocks: [{ kind: "text", text: "Recover this context." }],
      prompt: "Recover this context.",
      trigger: "follow_up",
    });
    await expect(
      events.claimSteering({
        threadId: seeded.thread.id,
        botId: seeded.bot.id,
        runId: seeded.run.id,
        leaseOwner: "failure-worker",
        leaseFence: 4,
        seenIds: [],
      }),
    ).resolves.toHaveLength(1);

    const finalized = await events.finalizeRun({
      spaceId: seeded.me.spaceId,
      threadId: seeded.thread.id,
      botId: seeded.bot.id,
      runId: seeded.run.id,
      taskId: seeded.task.id,
      attemptId: attempt.id,
      leaseOwner: "failure-worker",
      leaseFence: 4,
      outcome: "failed",
      error: "provider failed",
    });
    if (!finalized) throw new Error("Expected the failed run to finalize");
    const continuationRunId = finalized.continuationRunId;
    expect(continuationRunId).toEqual(expect.any(String));
    await expect(
      handles.prisma.run.findUniqueOrThrow({
        where: { id: continuationRunId! },
        include: { task: true },
      }),
    ).resolves.toMatchObject({
      status: "queued",
      trigger: "follow_up",
      task: { prompt: "Respond to the user's steering context." },
    });
    await expect(
      handles.prisma.steeringMessage.findFirstOrThrow({ where: { botId: seeded.bot.id } }),
    ).resolves.toMatchObject({ runId: continuationRunId, claimedAt: null });
  });

  it("discards pending steering when the user stops active work", async () => {
    const seeded = await seedRun("steering-stop", "keep working", {
      status: "running",
      leaseOwner: "stop-worker",
      leaseFence: 1,
      leaseExpiresAt: new Date(Date.now() + 60_000),
      startedAt: new Date(),
    });
    await rpc(seeded.cookie, "threads/send", {
      botId: seeded.bot.id,
      text: "Context that should stop with the run.",
      clientNonce: `stop-steering-${stamp}`,
    });

    await rpc(seeded.cookie, "threads/stop", { botId: seeded.bot.id });

    await expect(
      handles.prisma.run.findUniqueOrThrow({ where: { id: seeded.run.id } }),
    ).resolves.toMatchObject({ status: "cancelled" });
    expect(await handles.prisma.steeringMessage.count({ where: { botId: seeded.bot.id } })).toBe(0);
    expect(await handles.prisma.run.count({ where: { threadId: seeded.thread.id } })).toBe(1);
  });

  it("turns a regular bot-thread send during active work into steering", async () => {
    const seeded = await seedRun("bot-steering-send", "keep working", {
      status: "running",
      leaseOwner: "busy-worker",
      leaseFence: 1,
      leaseExpiresAt: new Date(Date.now() + 60_000),
      startedAt: new Date(),
    });

    const steeringInput = {
      botId: seeded.bot.id,
      text: "Use this additional context.",
      clientNonce: `bot-steering-${stamp}`,
    };
    await rpc(seeded.cookie, "threads/send", steeringInput);
    await rpc(seeded.cookie, "threads/send", steeringInput);

    expect(await handles.prisma.run.count({ where: { threadId: seeded.thread.id } })).toBe(1);
    expect(
      await handles.prisma.message.count({
        where: { threadId: seeded.thread.id, clientNonce: steeringInput.clientNonce },
      }),
    ).toBe(1);
    await expect(
      handles.prisma.steeringMessage.findFirstOrThrow({
        where: { botId: seeded.bot.id, message: { threadId: seeded.thread.id } },
      }),
    ).resolves.toMatchObject({ runId: seeded.run.id, claimedAt: null });
  });

  it("applies the same no-parallel-run rule to the targeted group member", async () => {
    const cookie = await signup(
      `executor-group-steering-${stamp}@rakazo.test`,
      "Executor group steering",
    );
    const me = await rpc<{ userId: string; spaceId: string }>(cookie, "me");
    const botA = await rpc<{ id: string }>(cookie, "bots/create", {
      name: "Group lead",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: false,
    });
    const botB = await rpc<{ id: string }>(cookie, "bots/create", {
      name: "Group helper",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: false,
    });
    const group = await rpc<{ id: string }>(cookie, "groups/create", {
      name: "Steering group",
      botIds: [botA.id, botB.id],
    });
    const thread = await handles.prisma.thread.findUniqueOrThrow({ where: { groupId: group.id } });
    const member = await handles.prisma.chatGroupMember.findFirstOrThrow({
      where: { groupId: group.id },
      orderBy: { createdAt: "asc" },
    });
    const task = await handles.prisma.task.create({
      data: {
        spaceId: me.spaceId,
        botId: member.botId,
        threadId: thread.id,
        userId: me.userId,
        prompt: "keep working",
        status: "queued",
      },
    });
    const activeRun = await handles.prisma.run.create({
      data: {
        spaceId: me.spaceId,
        botId: member.botId,
        threadId: thread.id,
        taskId: task.id,
        userId: me.userId,
        status: "running",
        trigger: "user",
        leaseOwner: "group-worker",
        leaseFence: 1,
        leaseExpiresAt: new Date(Date.now() + 60_000),
        startedAt: new Date(),
      },
    });

    await rpc(cookie, "threads/send", {
      groupId: group.id,
      text: "Use this group context.",
      mentions: [{ kind: "bot", id: member.botId }],
      clientNonce: `group-steering-${stamp}`,
    });

    expect(await handles.prisma.run.count({ where: { threadId: thread.id } })).toBe(1);
    await expect(
      handles.prisma.steeringMessage.findFirstOrThrow({
        where: { botId: member.botId, message: { threadId: thread.id } },
      }),
    ).resolves.toMatchObject({ runId: activeRun.id, claimedAt: null });

    const otherBotId = botA.id === member.botId ? botB.id : botA.id;
    const mixedInput = {
      groupId: group.id,
      text: "Use both agents.",
      mentions: [
        { kind: "bot", id: member.botId },
        { kind: "bot", id: otherBotId },
      ],
      clientNonce: `group-mixed-${stamp}`,
    };
    const first = await rpc<{ runIds: string[] }>(cookie, "threads/send", mixedInput);
    const replay = await rpc<{ runIds: string[] }>(cookie, "threads/send", mixedInput);
    expect(first.runIds).toHaveLength(2);
    expect(replay.runIds).toEqual(first.runIds);
    expect(await handles.prisma.run.count({ where: { threadId: thread.id } })).toBe(2);
  });

  async function seedRun(
    label: string,
    prompt: string,
    runState: {
      status?: string;
      leaseOwner?: string;
      leaseFence?: number;
      leaseExpiresAt?: Date;
      startedAt?: Date;
      completedAt?: Date;
    } = {},
  ) {
    const cookie = await signup(`executor-${label}-${stamp}@rakazo.test`, `Executor ${label}`);
    const me = await rpc<{ userId: string; spaceId: string }>(cookie, "me");
    const bot = await rpc<{ id: string }>(cookie, "bots/create", {
      name: `Executor ${label}`,
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: false,
    });
    const thread = await handles.prisma.thread.findUniqueOrThrow({ where: { botId: bot.id } });
    const task = await handles.prisma.task.create({
      data: {
        spaceId: me.spaceId,
        botId: bot.id,
        threadId: thread.id,
        userId: me.userId,
        prompt,
        status: "queued",
      },
    });
    const run = await handles.prisma.run.create({
      data: {
        spaceId: me.spaceId,
        botId: bot.id,
        threadId: thread.id,
        taskId: task.id,
        userId: me.userId,
        status: runState.status ?? "queued",
        trigger: "user",
        leaseOwner: runState.leaseOwner,
        leaseFence: runState.leaseFence,
        leaseExpiresAt: runState.leaseExpiresAt,
        startedAt: runState.startedAt,
        completedAt: runState.completedAt,
      },
    });
    return { cookie, me, bot, thread, task, run };
  }

  async function signup(email: string, name: string) {
    const response = await handles.app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://127.0.0.1:5173" },
      body: JSON.stringify({ email, password: "password12", name }),
    });
    expect(response.status).toBeLessThan(400);
    const raw = response.headers.get("set-cookie") ?? "";
    const match = raw.match(/better-auth\.session_token=([^;]+)/);
    expect(match?.[1]).toBeTruthy();
    return `better-auth.session_token=${match![1]}`;
  }

  async function rpc<T>(cookie: string, procedure: string, body: unknown = {}): Promise<T> {
    const response = await handles.app.request(`/rpc/${procedure}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://127.0.0.1:5173",
        cookie,
      },
      body: JSON.stringify({ json: body }),
    });
    const payload = (await response.json()) as { json?: T; error?: { message?: string } };
    if (!response.ok || payload.error) {
      throw new Error(payload.error?.message ?? `${procedure} failed (${response.status})`);
    }
    return payload.json as T;
  }
});
