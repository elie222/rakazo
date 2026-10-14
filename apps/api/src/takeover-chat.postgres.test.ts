import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { RPCHandler } from "@orpc/server/fetch";
import type { AgentRunRequest, JobPublisher } from "@rakazo/adapter-kit";
import {
  createRunExecutor,
  EncryptedSecretStore,
  FakeBrowserProvider,
  FakeSandboxProvider,
  LocalAgentHomeStore,
  ScriptedAgentRuntime,
} from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { createDb, createThreadEvents } from "@rakazo/db";
import { MarkdownMemoryStore } from "@rakazo/memory";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

const describePostgres =
  process.env.VERIFY_DATABASE === "1" && process.env.DATABASE_URL
    ? describe.sequential
    : describe.skip;

describePostgres("chat replies during screen takeover (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let prisma: PrismaClient;
  let dataDir: string;
  const organizations: string[] = [];

  beforeAll(async () => {
    db = createDb(process.env.DATABASE_URL!);
    prisma = db.prisma;
    dataDir = await mkdtemp(join(process.cwd(), ".takeover-chat-test-"));
    await prisma.deploymentSettings.upsert({
      where: { id: "default" },
      create: {
        id: "default",
        defaultModelProvider: "openrouter",
        defaultModelId: "openai/gpt-4o",
      },
      update: { defaultModelProvider: "openrouter", defaultModelId: "openai/gpt-4o" },
    });
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.organization.deleteMany({ where: { id: { in: organizations } } });
      await prisma.user.deleteMany({ where: { id: { in: organizations } } });
      await prisma.$disconnect();
      await db.pool.end();
    }
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  });

  async function setup() {
    const id = randomUUID();
    organizations.push(id);
    await prisma.user.create({
      data: { id, name: "Takeover fixture", email: `${id}@example.test`, emailVerified: true },
    });
    await prisma.organization.create({
      data: { id, name: "Takeover fixture", slug: id, createdAt: new Date() },
    });
    await prisma.space.create({ data: { id, organizationId: id, name: "Fixture" } });
    const computer = await prisma.computer.create({
      data: { spaceId: id, userId: id, scopeKey: id, homeKey: id, kind: "fake", state: "running" },
    });
    const bot = await prisma.bot.create({
      data: { spaceId: id, userId: id, name: "Fixture", color: "test", computerId: computer.id },
    });
    const thread = await prisma.thread.create({ data: { spaceId: id, userId: id, botId: bot.id } });
    const task = await prisma.task.create({
      data: {
        spaceId: id,
        userId: id,
        botId: bot.id,
        threadId: thread.id,
        prompt: "Enter the provided code on the fixture page.",
        status: "running",
      },
    });
    const run = await prisma.run.create({
      data: {
        spaceId: id,
        userId: id,
        botId: bot.id,
        threadId: thread.id,
        taskId: task.id,
        status: "waiting_takeover",
        trigger: "user",
      },
    });
    await prisma.computerExecutionLease.create({
      data: {
        computerId: computer.id,
        botId: bot.id,
        runId: run.id,
        fence: 1,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    const actor: Actor = {
      spaceId: id,
      userId: id,
      email: `${id}@example.test`,
      isDeploymentOwner: false,
    };
    const sandbox = new FakeSandboxProvider();
    const ref = await sandbox.provision(
      { botId: computer.id, homePath: dataDir },
      {
        ...actor,
        operationId: "fixture",
        traceId: "fixture",
        signal: new AbortController().signal,
      },
    );
    const leaseId = randomUUID();
    await prisma.computer.update({
      where: { id: computer.id },
      data: {
        providerRef: ref.id,
        controlHolder: "user",
        controlBotId: bot.id,
        controlRunId: run.id,
        controlLeaseId: leaseId,
        controlLeaseExpiresAt: new Date(Date.now() + 60_000),
      },
    });
    const events = createThreadEvents(prisma);
    const queuedStates: Array<{ status: string; checkpoint: string | null }> = [];
    const enqueue = vi.fn<JobPublisher["enqueue"]>(async (job) => {
      if (job.name === "run.continue") {
        queuedStates.push(await prisma.run.findUniqueOrThrow({ where: { id: job.payload.runId } }));
      }
    });
    const jobs: JobPublisher = {
      enqueue,
      cancel: vi.fn(async () => undefined),
      close: async () => undefined,
    };
    const deps = {
      prisma,
      events,
      jobs,
      sandbox,
      env: { agentRuntime: "scripted" },
    } as unknown as RouterDeps;
    const handler = new RPCHandler(createRouter(deps));
    const send = async (input: Record<string, unknown> = {}) => {
      const { response } = await handler.handle(
        new Request("http://127.0.0.1/rpc/threads/send", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            json: { botId: bot.id, text: "The fixture code is 1234.", ...input },
          }),
        }),
        { prefix: "/rpc", context: { actor } },
      );
      return response!;
    };
    const control = () => prisma.computer.findUniqueOrThrow({ where: { id: computer.id } });
    return {
      actor,
      bot,
      thread,
      run,
      computer,
      sandbox,
      events,
      jobs,
      enqueue,
      queuedStates,
      send,
      control,
      leaseId,
    };
  }

  it("releases the screen before either continuation is queued and executes the steering once", async () => {
    const fixture = await setup();
    const revoke = vi.spyOn(fixture.sandbox, "setScreenControl");
    const response = await fixture.send({ clientNonce: "takeover-reply" });
    expect(response.status).toBe(200);
    const { json: sent } = await response.json();
    const message = await prisma.message.findUniqueOrThrow({
      where: {
        threadId_clientNonce: { threadId: fixture.thread.id, clientNonce: "takeover-reply" },
      },
    });
    expect(sent.runId).toBe(fixture.run.id);
    expect(await fixture.control()).toMatchObject({
      controlHolder: "bot",
      controlRunId: null,
      controlBotId: null,
      controlLeaseId: null,
      controlLeaseExpiresAt: null,
    });
    expect(revoke).toHaveBeenCalledWith(
      expect.anything(),
      false,
      expect.anything(),
      fixture.leaseId,
    );
    expect(
      await prisma.event.findMany({
        where: { runId: fixture.run.id, type: "computer.takeover.released" },
      }),
    ).toMatchObject([{ payload: { holder: "bot", reason: "done", leaseId: fixture.leaseId } }]);
    expect(fixture.queuedStates).toEqual([
      expect.objectContaining({ status: "queued", checkpoint: "takeover" }),
      expect.objectContaining({ status: "queued", checkpoint: "takeover" }),
    ]);

    const requests: AgentRunRequest[] = [];
    const runtime = {
      describe: () => ({
        ...new ScriptedAgentRuntime().describe(),
        capabilities: { streaming: true, compaction: false, tools: true, scripted: false },
      }),
      abort: async () => undefined,
      async *run(request: AgentRunRequest) {
        requests.push(request);
        expect(request.resumeFromCheckpoint).toBe("takeover");
        expect(request.instructions).not.toContain("The user has the screen");
        expect(request.tools.map((tool) => tool.name)).toEqual(
          expect.arrayContaining(["computer_act", "browser_navigate"]),
        );
        const steering = await request.claimSteering!([]);
        expect(steering).toMatchObject([
          { messageId: message.id, text: "The fixture code is 1234." },
        ]);
        expect(await request.claimSteering!(steering.map((item) => item.id))).toEqual([]);
        await request.executeTool!(
          "computer_act",
          { actions: [{ kind: "type", text: "1234" }], observe: false, settle_ms: 0 },
          "reply-action",
        );
        await request.executeTool!(
          "browser_navigate",
          { url: "https://fixture.test" },
          "reply-browser",
        );
        yield { type: "done" as const, text: "Fixture completed." };
      },
    };
    const act = vi.spyOn(fixture.sandbox, "act");
    const browser = new FakeBrowserProvider({
      pages: { "https://fixture.test": { html: "<p>Fixture</p>" } },
    });
    const navigate = vi.spyOn(browser, "navigate");
    const executor = createRunExecutor({
      prisma,
      events: fixture.events,
      jobs: fixture.jobs,
      sandbox: fixture.sandbox,
      browser,
      runtime,
      home: new LocalAgentHomeStore(dataDir),
      memory: new MarkdownMemoryStore(prisma),
      memoryProviders: { resolve: async () => null },
      secretStore: new EncryptedSecretStore("fake-fixture-encryption-key"),
      secrets: [],
      deploymentModelKey: "fake-fixture-model-key",
      deploymentModelConfigured: true,
      dataDir,
    });
    await Promise.all([
      executor.continueRun(fixture.run.id, "steering-worker"),
      executor.continueRun(fixture.run.id, "release-worker"),
    ]);
    expect(await prisma.run.findUniqueOrThrow({ where: { id: fixture.run.id } })).toMatchObject({
      status: "completed",
      error: null,
    });
    expect(requests).toHaveLength(1);
    expect(act).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(await prisma.attempt.count({ where: { runId: fixture.run.id } })).toBe(1);
    expect(await prisma.steeringMessage.count({ where: { messageId: message.id } })).toBe(0);
    await executor.continueRun(fixture.run.id, "late-worker");
    expect(requests).toHaveLength(1);
  });

  it.each(["none", "other-run", "other-bot", "idle"])(
    "keeps unrelated computer control (%s)",
    async (owner) => {
      const fixture = await setup();
      await prisma.computer.update({
        where: { id: fixture.computer.id },
        data:
          owner === "none"
            ? {
                controlHolder: "none",
                controlRunId: null,
                controlBotId: null,
                controlLeaseId: null,
                controlLeaseExpiresAt: null,
              }
            : owner === "other-run"
              ? { controlRunId: "different-run" }
              : owner === "other-bot"
                ? { controlBotId: "different-bot" }
                : { controlRunId: null },
      });
      const before = await fixture.control();
      const revoke = vi.spyOn(fixture.sandbox, "setScreenControl");
      expect((await fixture.send()).status).toBe(200);
      expect(await fixture.control()).toEqual(before);
      expect(revoke).not.toHaveBeenCalled();
      expect(
        await prisma.event.count({
          where: { threadId: fixture.thread.id, type: "computer.takeover.released" },
        }),
      ).toBe(0);
      expect(await prisma.run.findUniqueOrThrow({ where: { id: fixture.run.id } })).toMatchObject({
        status: "waiting_takeover",
        checkpoint: null,
      });
    },
  );

  it("does not release a bot's takeover when the user sends to a group", async () => {
    const fixture = await setup();
    const otherBot = await prisma.bot.create({
      data: {
        spaceId: fixture.actor.spaceId,
        userId: fixture.actor.userId,
        name: "Other",
        color: "test",
      },
    });
    const group = await prisma.chatGroup.create({
      data: {
        spaceId: fixture.actor.spaceId,
        userId: fixture.actor.userId,
        name: "Fixture group",
        members: { create: [{ botId: fixture.bot.id }, { botId: otherBot.id }] },
        thread: { create: { spaceId: fixture.actor.spaceId, userId: fixture.actor.userId } },
      },
    });
    const before = await fixture.control();
    const revoke = vi.spyOn(fixture.sandbox, "setScreenControl");
    expect((await fixture.send({ botId: undefined, groupId: group.id })).status).toBe(200);
    expect(await fixture.control()).toEqual(before);
    expect(revoke).not.toHaveBeenCalled();
    expect(
      await prisma.event.count({
        where: { threadId: fixture.thread.id, type: "computer.takeover.released" },
      }),
    ).toBe(0);
  });

  it("retries a failed screen revocation without losing or duplicating the steering message", async () => {
    const fixture = await setup();
    const revoke = vi
      .spyOn(fixture.sandbox, "setScreenControl")
      .mockRejectedValueOnce(new Error("Fixture revocation failed"));
    expect((await fixture.send({ clientNonce: "retry-reply" })).status).toBe(500);
    expect(await fixture.control()).toMatchObject({
      controlHolder: "user",
      controlLeaseId: fixture.leaseId,
    });
    expect(fixture.queuedStates).toEqual([]);
    expect((await fixture.send({ clientNonce: "retry-reply" })).status).toBe(200);
    expect(revoke).toHaveBeenCalledTimes(2);
    expect(await fixture.control()).toMatchObject({ controlHolder: "bot", controlLeaseId: null });
    expect(
      await prisma.message.count({
        where: { threadId: fixture.thread.id, clientNonce: "retry-reply" },
      }),
    ).toBe(1);
    expect(await prisma.steeringMessage.count({ where: { runId: fixture.run.id } })).toBe(1);
    expect(
      await prisma.event.count({
        where: { runId: fixture.run.id, type: "computer.takeover.released" },
      }),
    ).toBe(1);
    expect(fixture.queuedStates).toEqual([
      expect.objectContaining({ status: "queued", checkpoint: "takeover" }),
      expect.objectContaining({ status: "queued", checkpoint: "takeover" }),
    ]);
  });

  it("keeps a later takeover when an already delivered reply is retried", async () => {
    const fixture = await setup();
    expect((await fixture.send({ clientNonce: "delivered-reply" })).status).toBe(200);
    await prisma.steeringMessage.updateMany({
      where: { runId: fixture.run.id },
      data: { claimedAt: new Date() },
    });
    await prisma.run.update({
      where: { id: fixture.run.id },
      data: { status: "waiting_takeover", checkpoint: null },
    });
    await prisma.computer.update({
      where: { id: fixture.computer.id },
      data: {
        controlHolder: "user",
        controlBotId: fixture.bot.id,
        controlRunId: fixture.run.id,
        controlLeaseId: randomUUID(),
        controlLeaseExpiresAt: new Date(Date.now() + 60_000),
      },
    });
    const before = await fixture.control();
    const revoke = vi.spyOn(fixture.sandbox, "setScreenControl");
    expect((await fixture.send({ clientNonce: "delivered-reply" })).status).toBe(200);
    expect(await fixture.control()).toEqual(before);
    expect(revoke).not.toHaveBeenCalled();
    expect(
      await prisma.event.count({
        where: { runId: fixture.run.id, type: "computer.takeover.released" },
      }),
    ).toBe(1);
  });
});
