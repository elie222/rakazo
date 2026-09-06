import { randomUUID } from "node:crypto";
import type { AdapterContext, BackgroundJob, JobPublisher } from "@rakazo/adapter-kit";
import { clearThread, createDb, type PrismaClient } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CloudAgentConnection } from "./cloud-agent-factory.js";
import { pollCloudAgent } from "./cloud-agent-poll.js";
import { executeCloudAgentTool, reconcileCloudAgents } from "./cloud-agent-service.js";
import { CursorCloudAgentProvider } from "./cursor-cloud-agent.js";
import { createJobReconciler } from "./job-reconciler.js";
import { CursorCloudAgentEmulator } from "./testing/cursor-cloud-agent-emulator.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const describePostgres =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe.sequential : describe.skip;

describePostgres("cloud agent lifecycle and recovery (PostgreSQL + Cursor emulator)", () => {
  let prisma: PrismaClient;
  let db: ReturnType<typeof createDb>;
  const users: string[] = [];
  beforeAll(() => {
    db = createDb(process.env.DATABASE_URL!);
    prisma = db.prisma;
  });
  afterAll(async () => {
    if (!db) return;
    await prisma.cloudAgent.deleteMany({ where: { userId: { in: users } } });
    await prisma.organization.deleteMany({ where: { id: { in: users } } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
    await db.prisma.$disconnect();
    await db.pool.end();
  });

  async function setup() {
    const id = randomUUID();
    users.push(id);
    await prisma.user.create({
      data: { id, name: "Cloud test", email: `${id}@example.test`, emailVerified: true },
    });
    await prisma.organization.create({
      data: { id, name: "Cloud test", slug: id, createdAt: new Date() },
    });
    await prisma.space.create({
      data: { id, organizationId: id, name: "Cloud test", isDefault: true },
    });
    await prisma.member.create({
      data: { id, organizationId: id, userId: id, role: "owner", createdAt: new Date() },
    });
    const bot = await prisma.bot.create({
      data: { spaceId: id, userId: id, name: "Cloud test", color: "test-color" },
    });
    const thread = await prisma.thread.create({ data: { spaceId: id, userId: id, botId: bot.id } });
    const task = await prisma.task.create({
      data: {
        spaceId: id,
        userId: id,
        botId: bot.id,
        threadId: thread.id,
        prompt: "Test",
        status: "completed",
      },
    });
    const run = await prisma.run.create({
      data: {
        spaceId: id,
        userId: id,
        botId: bot.id,
        threadId: thread.id,
        taskId: task.id,
        status: "completed",
        trigger: "user",
      },
    });
    const wire = new CursorCloudAgentEmulator();
    const connection: CloudAgentConnection = {
      key: `test-connection:${id}`,
      spaceId: id,
      provider: new CursorCloudAgentProvider({ apiKey: "fake-key", fetch: wire.fetch }),
    };
    const enqueue = vi.fn(async (_job: BackgroundJob) => undefined);
    const jobs: JobPublisher = {
      enqueue,
      cancel: async () => undefined,
      close: async () => undefined,
    };
    const deps = {
      prisma,
      jobs,
      events: { notify: vi.fn(async () => undefined) },
      cloudAgent: connection,
    };
    const context: AdapterContext & { botId: string } = {
      operationId: randomUUID(),
      traceId: "test",
      spaceId: id,
      userId: id,
      botId: bot.id,
      signal: new AbortController().signal,
    };
    const tool = (
      name: string,
      args: Record<string, unknown>,
      overrides: Partial<typeof context> = {},
    ) =>
      executeCloudAgentTool(deps, { ...context, ...overrides }, run, `cloud_agent_${name}`, args);
    const launch = async () => {
      const result = await tool("launch", {
        prompt: "Add README",
        repository: "https://github.com/example/demo",
        openPr: true,
      });
      if (!("id" in result)) throw new Error("Launch failed");
      return result.id;
    };
    const state = (agentId: string) =>
      prisma.cloudAgent.findUniqueOrThrow({ where: { id: agentId } });
    const poll = (agentId: string) => pollCloudAgent(deps, { agentId });
    const clear = () => clearThread(prisma, { spaceId: id, botId: bot.id, threadId: thread.id });
    const wakes = () =>
      prisma.run.findMany({ where: { threadId: thread.id, trigger: "cloud_agent" } });
    const finish = async (agentId: string) => {
      wire.complete((await state(agentId)).remoteId!);
      await poll(agentId);
    };
    return {
      id,
      bot,
      thread,
      run,
      wire,
      connection,
      enqueue,
      deps,
      context,
      tool,
      launch,
      state,
      poll,
      clear,
      wakes,
      finish,
    };
  }

  it("persists before remote I/O, launches once, and wakes exactly once per generation", async () => {
    const h = await setup();
    const id = await h.launch();
    expect(h.wire.requests).toHaveLength(0);
    expect(await h.launch()).toBe(id);
    expect(await prisma.cloudAgent.count({ where: { userId: h.id } })).toBe(1);
    await h.poll(id);
    await h.finish(id);
    expect(await h.state(id)).toMatchObject({
      status: "finished",
      wakeGeneration: 0,
      nextPollAt: null,
    });
    expect(await h.wakes()).toHaveLength(1);
    await prisma.cloudAgent.update({ where: { id }, data: { nextPollAt: new Date() } });
    await h.poll(id);
    expect(await h.wakes()).toHaveLength(1);
  });

  it("recovers an accepted launch whose response was lost without creating a second remote agent", async () => {
    const h = await setup();
    const id = await h.launch();
    h.wire.loseNextLaunchResponse = true;
    await h.poll(id);
    expect(await h.state(id)).toMatchObject({
      remoteId: null,
      launchDispatched: true,
      status: "running",
    });
    h.connection.provider = new CursorCloudAgentProvider({
      apiKey: "fake-key",
      fetch: h.wire.fetch,
    });
    await h.poll(id);
    expect((await h.state(id)).remoteId).toBeTruthy();
    expect(h.wire.ids.size).toBe(1);
    expect(h.wire.requests.filter((request) => request.path === "/v1/agents")).toHaveLength(2);
  });

  it("reconciles durable launch and wake intents after queue failure", async () => {
    const h = await setup();
    h.enqueue.mockRejectedValue(new Error("Queue unavailable"));
    const id = await h.launch();
    expect((await h.state(id)).nextPollAt).not.toBeNull();
    h.enqueue.mockResolvedValue(undefined);
    h.enqueue.mockClear();
    await reconcileCloudAgents(h.deps);
    expect(h.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ name: "cloud_agent.poll", payload: { agentId: id } }),
    );
    await h.poll(id);
    h.enqueue.mockRejectedValue(new Error("Queue unavailable"));
    await h.finish(id);
    const [wake] = await h.wakes();
    expect(wake?.status).toBe("queued");
    h.enqueue.mockResolvedValue(undefined);
    h.enqueue.mockClear();
    await createJobReconciler({ prisma, jobs: h.deps.jobs }).reconcileOnce();
    expect(h.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ name: "run.continue", payload: { runId: wake!.id } }),
    );
  });

  it("never dispatches a launch whose card transaction fails", async () => {
    const h = await setup();
    await expect(h.tool("launch", { prompt: "Task" }, { userId: "wrong-owner" })).rejects.toThrow();
    expect(await prisma.cloudAgent.count({ where: { userId: h.id } })).toBe(0);
    expect(h.wire.requests).toHaveLength(0);
  });

  it("cancels locally when chat clears before dispatch, and remotely after dispatch", async () => {
    const before = await setup();
    const beforeId = await before.launch();
    await before.clear();
    await before.poll(beforeId);
    expect((await before.state(beforeId)).status).toBe("cancelled");
    expect(before.wire.requests).toHaveLength(0);
    const after = await setup();
    const afterId = await after.launch();
    await after.poll(afterId);
    await after.clear();
    await after.poll(afterId);
    expect(await after.state(afterId)).toMatchObject({ status: "cancelled", nextPollAt: null });
    expect(await prisma.message.count({ where: { threadId: after.thread.id } })).toBe(0);
    expect(await after.wakes()).toHaveLength(0);
    expect(await after.tool("status", { id: afterId })).toMatchObject({
      id: afterId,
      status: "cancelled",
    });
  });

  it("retains ownership and cancels when the original bot is deleted", async () => {
    const h = await setup();
    const id = await h.launch();
    await h.poll(id);
    await prisma.bot.delete({ where: { id: h.bot.id } });
    await h.poll(id);
    expect(await h.state(id)).toMatchObject({ status: "cancelled", nextPollAt: null });
  });

  it("does not wake an owner whose membership is revoked during the provider request", async () => {
    const h = await setup();
    const id = await h.launch();
    await h.poll(id);
    h.wire.complete((await h.state(id)).remoteId!);
    const original = h.connection.provider.get.bind(h.connection.provider);
    vi.spyOn(h.connection.provider, "get").mockImplementationOnce(async (...args) => {
      const snapshot = await original(...args);
      await prisma.spaceMember.delete({
        where: { spaceId_userId: { spaceId: h.id, userId: h.id } },
      });
      return snapshot;
    });
    await h.poll(id);
    expect(await h.wakes()).toHaveLength(0);
    expect((await h.state(id)).nextPollAt).toBeNull();
  });

  it("isolates users, spaces, and credential bindings before any provider request", async () => {
    const h = await setup();
    const id = await h.launch();
    await h.poll(id);
    const requests = h.wire.requests.length;
    expect(await h.tool("cancel", { id }, { userId: "other-user" })).toMatchObject({
      error: "Unknown cloud agent.",
    });
    expect(
      await h.tool("reply", { id, prompt: "Attack" }, { spaceId: "other-space" }),
    ).toHaveProperty("error");
    h.connection.key = "rotated-key";
    expect(await h.tool("status", { id })).toMatchObject({ error: "Unknown cloud agent." });
    await h.poll(id);
    expect(h.wire.requests).toHaveLength(requests);
  });

  it("pins a follow-up to its returned run even when agent metadata is stale", async () => {
    const h = await setup();
    const id = await h.launch();
    await h.poll(id);
    await h.finish(id);
    const oldRun = (await h.state(id)).latestRunId!;
    await h.tool("reply", { id, prompt: "Add tests" });
    h.wire.staleLatestRunId = oldRun;
    await h.poll(id);
    const newRun = (await h.state(id)).latestRunId;
    expect(newRun).not.toBe(oldRun);
    await h.poll(id);
    expect((await h.state(id)).status).toBe("running");
    expect(await h.wakes()).toHaveLength(1);
    h.wire.complete((await h.state(id)).remoteId!);
    await h.poll(id);
    expect(await h.wakes()).toHaveLength(2);
    expect(await h.state(id)).toMatchObject({
      latestRunId: newRun,
      generation: 1,
      wakeGeneration: 1,
    });
  });

  it("cancels the known follow-up run even when latest agent metadata is stale", async () => {
    const h = await setup();
    const id = await h.launch();
    await h.poll(id);
    await h.finish(id);
    const oldRun = (await h.state(id)).latestRunId!;
    await h.tool("reply", { id, prompt: "Tests" });
    await h.poll(id);
    const newRun = (await h.state(id)).latestRunId;
    h.wire.staleLatestRunId = oldRun;
    await h.tool("cancel", { id });
    await h.poll(id);
    expect(await h.state(id)).toMatchObject({
      status: "cancelled",
      latestRunId: newRun,
      cancelRequested: false,
    });
  });

  it("reconciles a lost follow-up response without resending or waking on the previous run", async () => {
    const h = await setup();
    const id = await h.launch();
    await h.poll(id);
    await h.finish(id);
    const oldRun = (await h.state(id)).latestRunId!;
    await h.tool("reply", { id, prompt: "Add tests" });
    h.wire.loseNextReplyResponse = true;
    await h.poll(id);
    expect((await h.state(id)).followupDispatching).toBe(true);
    h.wire.staleLatestRunId = oldRun;
    await h.poll(id);
    expect((await h.state(id)).status).toBe("running");
    expect(await h.wakes()).toHaveLength(1);
    h.wire.staleLatestRunId = undefined;
    await h.poll(id);
    expect((await h.state(id)).followup).toBeNull();
    expect(
      h.wire.requests.filter(
        (request) => request.method === "POST" && request.path.endsWith("/runs"),
      ),
    ).toHaveLength(1);
  });

  it("does not report cancellation success while transport fails or the provider is still running", async () => {
    const h = await setup();
    const id = await h.launch();
    await h.poll(id);
    await h.tool("cancel", { id });
    h.wire.failNextRequest = 503;
    await h.poll(id);
    expect(await h.state(id)).toMatchObject({ status: "running", cancelRequested: true });
    h.wire.cancelPending = true;
    await h.poll(id);
    expect((await h.state(id)).nextPollAt!.getTime()).toBeGreaterThan(Date.now() + 1_000);
    expect(await h.state(id)).toMatchObject({ status: "running", cancelRequested: true });
    h.wire.cancelPending = false;
    await h.poll(id);
    expect(await h.state(id)).toMatchObject({ status: "cancelled", cancelRequested: false });
  });

  it("keeps cancellation pending while an ambiguous follow-up still reports the old run", async () => {
    const h = await setup();
    const id = await h.launch();
    await h.poll(id);
    await h.finish(id);
    const oldRun = (await h.state(id)).latestRunId!;
    await h.tool("reply", { id, prompt: "Tests" });
    h.wire.loseNextReplyResponse = true;
    await h.poll(id);
    await h.tool("cancel", { id });
    h.wire.staleLatestRunId = oldRun;
    await h.poll(id);
    expect(await h.state(id)).toMatchObject({
      status: "running",
      cancelRequested: true,
      followupDispatching: true,
    });
    h.wire.staleLatestRunId = undefined;
    await h.poll(id);
    expect(await h.state(id)).toMatchObject({
      status: "cancelled",
      cancelRequested: false,
      followup: null,
    });
  });

  it("cancels a queued follow-up without dispatching it", async () => {
    const h = await setup();
    const id = await h.launch();
    await h.poll(id);
    await h.finish(id);
    await h.tool("reply", { id, prompt: "Tests" });
    await h.tool("cancel", { id });
    const requests = h.wire.requests.length;
    await h.poll(id);
    expect(h.wire.requests).toHaveLength(requests);
    expect(await h.state(id)).toMatchObject({ status: "cancelled", followup: null });
  });

  it("recovers remote identity after the database fails following an accepted create", async () => {
    const h = await setup();
    const id = await h.launch();
    const original = h.connection.provider.launch.bind(h.connection.provider);
    vi.spyOn(h.connection.provider, "launch").mockImplementationOnce(async (...args) => {
      const result = await original(...args);
      vi.spyOn(prisma, "$transaction").mockRejectedValueOnce(new Error("Database unavailable"));
      return result;
    });
    await h.poll(id);
    expect((await h.state(id)).remoteId).toBeNull();
    await h.poll(id);
    expect((await h.state(id)).remoteId).toBeTruthy();
    expect(h.wire.ids.size).toBe(1);
  });

  it("fences concurrent pollers and preserves cancellation during launch", async () => {
    const h = await setup();
    const id = await h.launch();
    const entered = deferred();
    const release = deferred();
    const original = h.connection.provider.launch.bind(h.connection.provider);
    vi.spyOn(h.connection.provider, "launch").mockImplementationOnce(async (...args) => {
      entered.resolve();
      await release.promise;
      return original(...args);
    });
    const polling = h.poll(id);
    await entered.promise;
    await h.poll(id);
    await h.tool("cancel", { id });
    release.resolve();
    await polling;
    await h.poll(id);
    await h.poll(id);
    expect(h.wire.ids.size).toBe(1);
    expect(await h.state(id)).toMatchObject({ status: "cancelled", cancelRequested: false });
  });

  it("rejects overlapping follow-ups and preserves remote failure as a terminal result", async () => {
    const h = await setup();
    const id = await h.launch();
    await h.poll(id);
    expect(await h.tool("reply", { id, prompt: "Busy" })).toHaveProperty("error");
    h.wire.complete((await h.state(id)).remoteId!, { failed: true });
    await h.poll(id);
    expect((await h.state(id)).status).toBe("failed");
    expect(await h.wakes()).toHaveLength(1);
    await h.tool("reply", { id, prompt: "Try again" });
    expect(await h.tool("reply", { id, prompt: "Duplicate" })).toHaveProperty("error");
  });

  it("marks definitive create rejection failed while retaining retryable network failures", async () => {
    const h = await setup();
    const id = await h.launch();
    h.wire.failNextRequest = 503;
    await h.poll(id);
    expect(await h.state(id)).toMatchObject({ status: "running", errorCount: 1 });
    h.wire.failNextRequest = 400;
    await h.poll(id);
    expect(await h.state(id)).toMatchObject({ status: "failed", nextPollAt: null });
    expect(await h.wakes()).toHaveLength(1);
    expect(h.wire.ids.size).toBe(0);
  });
});
