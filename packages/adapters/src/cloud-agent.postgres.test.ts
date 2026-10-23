import { randomUUID } from "node:crypto";
import type { AdapterContext, BackgroundJob, JobPublisher } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { asSystem, clearThread, createDb, runAsSystem, runAsTenant } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { CursorCloudAgentEmulator } from "./cloud-agent-emulator.js";
import type { CloudAgentConnection } from "./cloud-agent-factory.js";
import { pollCloudAgent } from "./cloud-agent-poll.js";
import { executeCloudAgentTool, reconcileCloudAgents } from "./cloud-agent-service.js";
import { CursorCloudAgentProvider } from "./cursor-cloud-agent.js";
import { createJobReconciler } from "./job-reconciler.js";

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
    const { bot, thread, run } = await runAsSystem("test fixture", async () => {
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
      const thread = await prisma.thread.create({
        data: { spaceId: id, userId: id, botId: bot.id },
      });
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
      return { bot, thread, run };
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
      runAsSystem("agent run tool call", () =>
        executeCloudAgentTool(deps, { ...context, ...overrides }, run, `cloud_agent_${name}`, args),
      );
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
    const poll = (agentId: string) =>
      runAsSystem("cloud agent poll job", () => pollCloudAgent(deps, { agentId }));
    // Clearing a chat is an API request by its owner.
    const clear = () =>
      runAsTenant({ spaceId: id, userId: id }, () =>
        clearThread(prisma, { spaceId: id, botId: bot.id, threadId: thread.id }),
      );
    const wakes = () =>
      asSystem(prisma).run.findMany({ where: { threadId: thread.id, trigger: "cloud_agent" } });
    const finish = async (agentId: string) => {
      wire.complete((await state(agentId)).remoteId!);
      await poll(agentId);
    };
    // Age an ambiguous follow-up past the window in which a late acceptance could appear.
    const settle = (agentId: string) =>
      prisma.cloudAgent.update({
        where: { id: agentId },
        data: { followupDispatchedAt: new Date(Date.now() - 10 * 60_000) },
      });
    const runs = async (agentId: string) => [
      ...wire.agents.get((await state(agentId)).remoteId!)!.runs.values(),
    ];
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
      settle,
      runs,
    };
  }

  it("forwards first-response timing when its cloud-agent card is the first output", async () => {
    const h = await setup();
    await h.launch();
    expect(h.deps.events.notify).toHaveBeenCalledWith(h.thread.id, expect.any(Number), h.run.id);
    expect(
      (await asSystem(prisma).run.findUniqueOrThrow({ where: { id: h.run.id } })).firstResponseAt,
    ).not.toBeNull();
  });

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
    expect(h.wire.agents.size).toBe(1);
    expect(h.wire.requests.filter((request) => request.path === "/v1/agents")).toHaveLength(2);
  });

  it("reconciles durable launch and wake intents after queue failure", async () => {
    const h = await setup();
    h.enqueue.mockRejectedValue(new Error("Queue unavailable"));
    const id = await h.launch();
    expect((await h.state(id)).nextPollAt).not.toBeNull();
    h.enqueue.mockResolvedValue(undefined);
    h.enqueue.mockClear();
    await runAsSystem("job reconciler", () => reconcileCloudAgents(h.deps));
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
    await runAsSystem("job reconciler", () =>
      createJobReconciler({ prisma, jobs: h.deps.jobs }).reconcileOnce(),
    );
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
    expect(
      await runAsSystem("test fixture", () =>
        prisma.message.count({ where: { threadId: after.thread.id } }),
      ),
    ).toBe(0);
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
    await asSystem(prisma).bot.delete({ where: { id: h.bot.id } });
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
    expect((await h.state(id)).followupDispatchedAt).not.toBeNull();
    h.wire.staleLatestRunId = oldRun;
    await h.poll(id);
    expect(await h.state(id)).toMatchObject({ status: "running", followup: null });
    expect((await h.state(id)).latestRunId).not.toBe(oldRun);
    expect(await h.wakes()).toHaveLength(1);
    expect(
      h.wire.requests.filter(
        (request) => request.method === "POST" && request.path.endsWith("/runs"),
      ),
    ).toHaveLength(1);
  });

  it("resends a follow-up whose pre-send read failed, since nothing was sent", async () => {
    const h = await setup();
    const id = await h.launch();
    await h.poll(id);
    await h.finish(id);
    await h.tool("reply", { id, prompt: "Add tests" });
    h.wire.failNextRequest = 503;
    await h.poll(id);
    expect(await h.state(id)).toMatchObject({ status: "running", followupDispatchedAt: null });
    await h.poll(id);
    expect(await h.state(id)).toMatchObject({ status: "running", followup: null });
    expect(await h.runs(id)).toHaveLength(2);
    await h.finish(id);
    expect((await h.state(id)).status).toBe("finished");
  });

  it.each([
    ["never accepted", false],
    ["accepted after the client gave up", true],
  ])("sends an ambiguous follow-up exactly once when it was %s", async (_label, late) => {
    const h = await setup();
    const id = await h.launch();
    await h.poll(id);
    await h.finish(id);
    await h.tool("reply", { id, prompt: "Add tests" });
    const remoteId = (await h.state(id)).remoteId!;
    let failed = false;
    h.connection.provider = new CursorCloudAgentProvider({
      apiKey: "fake-key",
      fetch: async (input, init) => {
        if (failed || init?.method !== "POST") return h.wire.fetch(input, init);
        failed = true;
        return new Response(null, { status: 503 });
      },
    });
    await h.poll(id);
    await h.poll(id);
    expect((await h.state(id)).followupDispatchedAt).not.toBeNull();
    expect(await h.runs(id)).toHaveLength(1);
    if (late) {
      await h.wire.fetch(`https://api.cursor.com/v1/agents/${remoteId}/runs`, {
        method: "POST",
        headers: { authorization: "Bearer fake-key" },
        body: JSON.stringify({ prompt: { text: "Add tests" } }),
      });
    } else {
      await h.settle(id);
      await h.poll(id);
      expect((await h.state(id)).followupDispatchedAt).toBeNull();
    }
    await h.poll(id);
    expect(await h.state(id)).toMatchObject({ status: "running", followup: null });
    expect(await h.runs(id)).toHaveLength(2);
    await h.finish(id);
    expect((await h.state(id)).status).toBe("finished");
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

  it.each([
    ["accepted", true],
    ["never accepted", false],
  ])("cancels an ambiguous follow-up that was %s", async (_label, accepted) => {
    const h = await setup();
    const id = await h.launch();
    await h.poll(id);
    await h.finish(id);
    const oldRun = (await h.state(id)).latestRunId!;
    await h.tool("reply", { id, prompt: "Tests" });
    if (accepted) h.wire.loseNextReplyResponse = true;
    else
      h.connection.provider = new CursorCloudAgentProvider({
        apiKey: "fake-key",
        fetch: async (input, init) =>
          init?.method === "POST" ? new Response(null, { status: 503 }) : h.wire.fetch(input, init),
      });
    await h.poll(id);
    expect((await h.state(id)).followupDispatchedAt).not.toBeNull();
    await h.tool("cancel", { id });
    h.wire.staleLatestRunId = oldRun;
    await h.poll(id);
    if (!accepted) {
      // A late acceptance could still appear, so cancellation waits for the run list to settle.
      expect(await h.state(id)).toMatchObject({ status: "running", cancelRequested: true });
      await h.settle(id);
      await h.poll(id);
    }
    expect(await h.state(id)).toMatchObject({
      status: "cancelled",
      cancelRequested: false,
      followup: null,
      followupDispatchedAt: null,
      nextPollAt: null,
    });
    expect((await h.runs(id)).map((run) => run.status)).toEqual(
      accepted ? ["FINISHED", "CANCELLED"] : ["FINISHED"],
    );
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
    expect(h.wire.agents.size).toBe(1);
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
    expect(h.wire.agents.size).toBe(1);
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
    expect(h.wire.agents.size).toBe(0);
  });

  it("stops polling a remote agent or run that no longer exists", async () => {
    const h = await setup();
    const id = await h.launch();
    await h.poll(id);
    h.wire.agents.delete((await h.state(id)).remoteId!);
    await h.poll(id);
    expect(await h.state(id)).toMatchObject({ status: "failed", nextPollAt: null });
    expect(await h.wakes()).toHaveLength(1);
    const cancelled = await setup();
    const cancelledId = await cancelled.launch();
    await cancelled.poll(cancelledId);
    await cancelled.tool("cancel", { id: cancelledId });
    cancelled.wire.agents.delete((await cancelled.state(cancelledId)).remoteId!);
    await cancelled.poll(cancelledId);
    expect(await cancelled.state(cancelledId)).toMatchObject({
      status: "cancelled",
      cancelRequested: false,
      nextPollAt: null,
    });
  });

  it("keeps polling through unknown statuses, a rejected key, and rate limits", async () => {
    const h = await setup();
    const id = await h.launch();
    h.wire.apiKey = "revoked-key";
    await h.poll(id);
    expect(await h.state(id)).toMatchObject({ status: "running", remoteId: null, errorCount: 1 });
    h.wire.apiKey = "fake-key";
    await h.poll(id);
    const remoteId = (await h.state(id)).remoteId!;
    expect(remoteId).toBeTruthy();
    h.wire.setRunStatus(remoteId, "SOME_FUTURE_STATUS");
    await h.poll(id);
    expect(await h.state(id)).toMatchObject({ status: "running", errorCount: 0 });
    h.wire.apiKey = "revoked-key";
    await h.poll(id);
    expect(await h.state(id)).toMatchObject({ status: "running", errorCount: 1 });
    h.wire.apiKey = "fake-key";
    h.wire.failNextRequest = 429;
    await h.poll(id);
    expect((await h.state(id)).nextPollAt!.getTime()).toBeGreaterThan(Date.now() + 29_000);
    await h.finish(id);
    expect(await h.state(id)).toMatchObject({ status: "finished", errorCount: 0 });
  });

  it("reports a follow-up to an expired agent as expired", async () => {
    const h = await setup();
    const id = await h.launch();
    await h.poll(id);
    await h.finish(id);
    h.wire.archive((await h.state(id)).remoteId!);
    await h.tool("reply", { id, prompt: "Add tests" });
    await h.poll(id);
    expect(await h.state(id)).toMatchObject({
      status: "expired",
      followup: null,
      followupDispatchedAt: null,
      nextPollAt: null,
    });
    expect(await h.wakes()).toHaveLength(2);
  });

  it("resends a follow-up the provider refused for its key or rate limit", async () => {
    const h = await setup();
    const id = await h.launch();
    await h.poll(id);
    await h.finish(id);
    await h.tool("reply", { id, prompt: "Add tests" });
    h.wire.apiKey = "revoked-key";
    await h.poll(id);
    expect(await h.state(id)).toMatchObject({ status: "running", followupDispatchedAt: null });
    h.wire.apiKey = "fake-key";
    const replies = () =>
      h.wire.requests.filter(
        (request) => request.method === "POST" && request.path.endsWith("/runs"),
      ).length;
    h.wire.requests.length = 0;
    // The pre-read succeeds; the follow-up POST itself is rate limited.
    let limited = false;
    h.connection.provider = new CursorCloudAgentProvider({
      apiKey: "fake-key",
      fetch: async (input, init) => {
        if (!limited && init?.method === "POST") {
          limited = true;
          h.wire.failNextRequest = 429;
        }
        return h.wire.fetch(input, init);
      },
    });
    await h.poll(id);
    expect(await h.state(id)).toMatchObject({ followupDispatchedAt: null });
    expect((await h.state(id)).nextPollAt!.getTime()).toBeGreaterThan(Date.now() + 29_000);
    await h.poll(id);
    expect(await h.state(id)).toMatchObject({ followup: null, status: "running" });
    expect(replies()).toBe(2);
  });
});
