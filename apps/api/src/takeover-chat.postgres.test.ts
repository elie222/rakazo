import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { RPCHandler } from "@orpc/server/fetch";
import type { AgentRunRequest, JobPublisher } from "@rakazo/adapter-kit";
import { computerControlExpireJobKey, runJobKey } from "@rakazo/adapter-kit";
import {
  acquireComputerExecutionLease,
  ComputerBusyError,
  cancelComputerRunWorkArgv,
  createRunExecutor,
  EncryptedSecretStore,
  FakeBrowserProvider,
  FakeSandboxProvider,
  LocalAgentHomeStore,
  ScriptedAgentRuntime,
  screenLeaseIdForRun,
  updateFleetGroup,
} from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import {
  stuckWorkStatusMessage,
  TAKEOVER_COMPUTER_PENDING_STATE,
  TAKEOVER_COMPUTER_SKIPPED_STATE,
  TAKEOVER_WAIT_EXPIRE_AFTER_MS,
} from "@rakazo/core";
import type { Prisma, PrismaClient } from "@rakazo/db";
import {
  asSystem,
  createDb,
  createThreadEvents,
  endTakeoverWaits,
  expireStuckRun,
  runAsSystem,
  runAsTenant,
} from "@rakazo/db";
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
  let system: PrismaClient;
  let dataDir: string;
  const organizations: string[] = [];

  beforeAll(async () => {
    db = createDb(process.env.DATABASE_URL!);
    prisma = db.prisma;
    system = asSystem(prisma);
    dataDir = await mkdtemp(join(process.cwd(), ".takeover-chat-test-"));
    await system.deploymentSettings.upsert({
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
      await system.organization.deleteMany({ where: { id: { in: organizations } } });
      await system.user.deleteMany({ where: { id: { in: organizations } } });
      await prisma.$disconnect();
      await db.pool.end();
    }
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  });

  const endWaits = (runIds: string[]) =>
    runAsSystem("test takeover wait", () => endTakeoverWaits(prisma, runIds));

  async function setup(mode: "opened" | "unopened" = "opened", trigger = "user") {
    const id = randomUUID();
    organizations.push(id);
    await system.user.create({
      data: { id, name: "Takeover fixture", email: `${id}@example.test`, emailVerified: true },
    });
    await system.organization.create({
      data: { id, name: "Takeover fixture", slug: id, createdAt: new Date() },
    });
    await system.space.create({ data: { id, organizationId: id, name: "Fixture" } });
    const computer = await system.computer.create({
      data: { spaceId: id, userId: id, scopeKey: id, homeKey: id, kind: "fake", state: "running" },
    });
    const bot = await system.bot.create({
      data: { spaceId: id, userId: id, name: "Fixture", color: "test", computerId: computer.id },
    });
    const thread = await system.thread.create({ data: { spaceId: id, userId: id, botId: bot.id } });
    const task = await system.task.create({
      data: {
        spaceId: id,
        userId: id,
        botId: bot.id,
        threadId: thread.id,
        prompt: "Enter the provided code on the fixture page.",
        status: "running",
      },
    });
    const run = await system.run.create({
      data: {
        spaceId: id,
        userId: id,
        botId: bot.id,
        threadId: thread.id,
        taskId: task.id,
        status: "waiting_takeover",
        trigger,
      },
    });
    await system.computerExecutionLease.create({
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
    const events = createThreadEvents(prisma);
    await system.computer.update({
      where: { id: computer.id },
      data: { providerRef: ref.id },
    });
    let leaseId: string | null = null;
    if (mode === "opened") {
      leaseId = randomUUID();
      await system.computer.update({
        where: { id: computer.id },
        data: {
          controlHolder: "user",
          controlBotId: bot.id,
          controlRunId: run.id,
          controlLeaseId: leaseId,
          controlLeaseExpiresAt: new Date(Date.now() + 60_000),
        },
      });
    } else {
      const attempt = await system.attempt.create({
        data: { runId: run.id, fence: 1, status: "running" },
      });
      await system.run.update({
        where: { id: run.id },
        data: {
          status: "running",
          leaseOwner: "fixture-worker",
          leaseFence: 1,
          leaseExpiresAt: new Date(Date.now() + 60_000),
        },
      });
      await runAsSystem("test fixture", () =>
        events.pauseRunForTakeover({
          spaceId: id,
          threadId: thread.id,
          botId: bot.id,
          runId: run.id,
          attemptId: attempt.id,
          leaseOwner: "fixture-worker",
          leaseFence: 1,
          reason: "Enter the fixture code",
          computerId: computer.id,
        }),
      );
    }
    const queuedStates: Array<{ status: string; checkpoint: string | null }> = [];
    const enqueue = vi.fn<JobPublisher["enqueue"]>(async (job) => {
      if (job.name === "run.continue") {
        queuedStates.push(await system.run.findUniqueOrThrow({ where: { id: job.payload.runId } }));
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
    const control = () => system.computer.findUniqueOrThrow({ where: { id: computer.id } });
    /** `beforeGrant` runs just before the grant's write, after the route has read the wait. */
    const takeover = async (beforeGrant?: () => Promise<unknown>) => {
      const routed = beforeGrant ? beforeUserGrant(prisma, beforeGrant) : prisma;
      const { response } = await new RPCHandler(createRouter({ ...deps, prisma: routed })).handle(
        new Request("http://127.0.0.1/rpc/computer/takeover", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ json: { botId: bot.id } }),
        }),
        { prefix: "/rpc", context: { actor } },
      );
      return response!;
    };
    return {
      actor,
      bot,
      thread,
      run,
      computer,
      sandbox,
      events,
      deps,
      jobs,
      enqueue,
      queuedStates,
      send,
      takeover,
      control,
      leaseId,
    };
  }

  it.each(["waiting", "pause-during-revoke", "pause-after-handoff"] as const)(
    "skips the previous bot's takeover on a shared screen (%s)",
    async (timing) => {
      const fixture = await setup();
      const card = await system.message.create({
        data: {
          threadId: fixture.thread.id,
          botId: fixture.bot.id,
          runId: fixture.run.id,
          seq: 1,
          role: "bot",
          blocks: [{ kind: "computer", state: TAKEOVER_COMPUTER_PENDING_STATE, text: "Fixture" }],
        },
      });
      const preparePause = async () => {
        const attempt = await system.attempt.create({
          data: { runId: fixture.run.id, fence: 1, status: "running" },
        });
        await system.run.update({
          where: { id: fixture.run.id },
          data: { status: "running", leaseOwner: "fixture-worker", leaseFence: 1 },
        });
        return () =>
          runAsSystem("test takeover pause", () =>
            fixture.events.pauseRunForTakeover({
              spaceId: fixture.actor.spaceId,
              threadId: fixture.thread.id,
              botId: fixture.bot.id,
              runId: fixture.run.id,
              attemptId: attempt.id,
              leaseOwner: "fixture-worker",
              leaseFence: 1,
              reason: "Fixture",
              computerId: fixture.computer.id,
            }),
          );
      };
      const pause = timing === "waiting" ? null : await preparePause();
      if (timing === "pause-during-revoke") {
        // The route has already read the lease without a run binding when pause commits.
        await system.computer.update({
          where: { id: fixture.computer.id },
          data: { controlRunId: null },
        });
        const revoke = fixture.sandbox.setScreenControl.bind(fixture.sandbox);
        vi.spyOn(fixture.sandbox, "setScreenControl").mockImplementationOnce(async (...args) => {
          expect(await pause!()).toBe(true);
          return revoke(...args);
        });
      }

      const other = await system.bot.create({
        data: {
          spaceId: fixture.actor.spaceId,
          userId: fixture.actor.userId,
          name: "Other fixture",
          color: "test",
          computerId: fixture.computer.id,
        },
      });
      const { response } = await new RPCHandler(createRouter(fixture.deps)).handle(
        new Request("http://127.0.0.1/rpc/computer/takeover", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ json: { botId: other.id } }),
        }),
        { prefix: "/rpc", context: { actor: fixture.actor } },
      );
      expect(response?.status).toBe(200);
      if (timing === "pause-after-handoff") {
        // The runtime can publish its card after release has already settled earlier cards.
        await system.message.update({
          where: { id: card.id },
          data: {
            blocks: [{ kind: "computer", state: TAKEOVER_COMPUTER_PENDING_STATE, text: "Fixture" }],
          },
        });
        expect(await pause!()).toEqual({ continuationRunId: fixture.run.id });
      }

      // An old release delivery must not revoke the replacement lease or duplicate history.
      expect(
        await runAsSystem("test stale release", () =>
          fixture.events.finalizeComputerControlRelease({
            spaceId: fixture.actor.spaceId,
            computerId: fixture.computer.id,
            botId: fixture.bot.id,
            runId: fixture.run.id,
            leaseId: fixture.leaseId,
            holder: "bot",
            reason: "skipped",
          }),
        ),
      ).toBe(false);
      expect(await fixture.control()).toMatchObject({
        controlHolder: "user",
        controlBotId: other.id,
        controlRunId: null,
      });
      expect(await system.run.findUniqueOrThrow({ where: { id: fixture.run.id } })).toMatchObject({
        status: "queued",
        checkpoint: "takeover-skipped",
      });
      expect(
        await system.event.findMany({
          where: { runId: fixture.run.id, type: "computer.takeover.released" },
        }),
      ).toEqual([
        expect.objectContaining({ payload: expect.objectContaining({ reason: "skipped" }) }),
      ]);
      expect(await system.message.findUniqueOrThrow({ where: { id: card.id } })).toMatchObject({
        blocks: [{ kind: "computer", state: TAKEOVER_COMPUTER_SKIPPED_STATE, text: "Fixture" }],
      });
      expect(fixture.queuedStates).toEqual([
        expect.objectContaining({
          status: timing === "pause-after-handoff" ? "running" : "queued",
          checkpoint: "takeover-skipped",
        }),
      ]);
      expect(fixture.jobs.cancel).toHaveBeenCalledWith(
        computerControlExpireJobKey(fixture.computer.id, fixture.leaseId!),
      );
    },
  );

  it("releases the screen before either continuation is queued and executes the steering once", async () => {
    const fixture = await setup();
    const revoke = vi.spyOn(fixture.sandbox, "setScreenControl");
    const response = await fixture.send({ clientNonce: "takeover-reply" });
    expect(response.status).toBe(200);
    const { json: sent } = await response.json();
    const message = await system.message.findUniqueOrThrow({
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
      await system.event.findMany({
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
    // Run jobs act for the run's owner, as the background job handlers scope them.
    await runAsTenant(fixture.actor, () =>
      Promise.all([
        executor.continueRun(fixture.run.id, "steering-worker"),
        executor.continueRun(fixture.run.id, "release-worker"),
      ]),
    );
    expect(await system.run.findUniqueOrThrow({ where: { id: fixture.run.id } })).toMatchObject({
      status: "completed",
      error: null,
    });
    expect(requests).toHaveLength(1);
    expect(act).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(await system.attempt.count({ where: { runId: fixture.run.id } })).toBe(1);
    expect(await system.steeringMessage.count({ where: { messageId: message.id } })).toBe(0);
    await runAsTenant(fixture.actor, () => executor.continueRun(fixture.run.id, "late-worker"));
    expect(requests).toHaveLength(1);
  });

  it("releases an unopened takeover and restores tools for the steered continuation", async () => {
    const fixture = await setup("unopened");
    expect(await fixture.control()).toMatchObject({
      controlHolder: "none",
      controlBotId: null,
      controlLeaseId: null,
      controlRunId: fixture.run.id,
    });
    const response = await fixture.send({ clientNonce: "unopened-reply" });
    expect(response.status).toBe(200);
    const { json: sent } = await response.json();
    const message = await system.message.findUniqueOrThrow({
      where: {
        threadId_clientNonce: { threadId: fixture.thread.id, clientNonce: "unopened-reply" },
      },
    });
    expect(sent.runId).toBe(fixture.run.id);
    expect(await fixture.control()).toMatchObject({
      controlHolder: "bot",
      controlBotId: null,
      controlLeaseId: null,
      controlRunId: null,
    });
    expect(
      await system.event.findMany({
        where: { runId: fixture.run.id, type: "computer.takeover.released" },
      }),
    ).toMatchObject([{ payload: { holder: "bot", reason: "done", leaseId: null } }]);
    expect(await system.run.findUniqueOrThrow({ where: { id: fixture.run.id } })).toMatchObject({
      status: "queued",
      checkpoint: "takeover",
    });

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
        expect(await request.claimSteering!([])).toMatchObject([
          { messageId: message.id, text: "The fixture code is 1234." },
        ]);
        yield { type: "done" as const, text: "Fixture completed." };
      },
    };
    const executor = createRunExecutor({
      prisma,
      events: fixture.events,
      jobs: fixture.jobs,
      sandbox: fixture.sandbox,
      browser: new FakeBrowserProvider(),
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
    // Run jobs act for the run's owner, as the background job handlers scope them.
    await runAsTenant(fixture.actor, () =>
      Promise.all([
        executor.continueRun(fixture.run.id, "steering-worker"),
        executor.continueRun(fixture.run.id, "release-worker"),
      ]),
    );
    expect(await system.run.findUniqueOrThrow({ where: { id: fixture.run.id } })).toMatchObject({
      status: "completed",
      error: null,
    });
    expect(requests).toHaveLength(1);
    expect(await system.steeringMessage.count({ where: { messageId: message.id } })).toBe(0);
  });

  it.each(["none", "other-run", "other-bot", "idle"])(
    "keeps unrelated computer control (%s)",
    async (owner) => {
      const fixture = await setup();
      await system.computer.update({
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
        await system.event.count({
          where: { threadId: fixture.thread.id, type: "computer.takeover.released" },
        }),
      ).toBe(0);
      expect(await system.run.findUniqueOrThrow({ where: { id: fixture.run.id } })).toMatchObject({
        status: "waiting_takeover",
        checkpoint: null,
      });
    },
  );

  it("does not release a bot's takeover when the user sends to a group", async () => {
    const fixture = await setup();
    const otherBot = await system.bot.create({
      data: {
        spaceId: fixture.actor.spaceId,
        userId: fixture.actor.userId,
        name: "Other",
        color: "test",
      },
    });
    const group = await system.chatGroup.create({
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
      await system.event.count({
        where: { threadId: fixture.thread.id, type: "computer.takeover.released" },
      }),
    ).toBe(0);
  });

  describe("in a group chat", () => {
    /** The waiting run belongs to the second member; the first member has nothing to do with it. */
    async function setupGroup() {
      const fixture = await setup();
      const first = await system.bot.create({
        data: {
          spaceId: fixture.actor.spaceId,
          userId: fixture.actor.userId,
          name: "Bystander",
          color: "test",
        },
      });
      const group = await system.chatGroup.create({
        data: {
          spaceId: fixture.actor.spaceId,
          userId: fixture.actor.userId,
          name: "Fixture group",
          members: { create: [{ botId: first.id }, { botId: fixture.bot.id }] },
          thread: { create: { spaceId: fixture.actor.spaceId, userId: fixture.actor.userId } },
        },
        include: { thread: true },
      });
      const threadId = group.thread!.id;
      await system.task.updateMany({ where: { id: fixture.run.taskId }, data: { threadId } });
      await system.run.update({ where: { id: fixture.run.id }, data: { threadId } });
      const card = await system.message.create({
        data: {
          threadId,
          botId: fixture.bot.id,
          runId: fixture.run.id,
          seq: 1,
          role: "bot",
          blocks: [{ kind: "text", text: "Please enter the code on the screen." }],
        },
      });
      const call = async (path: "send" | "react", json: Record<string, unknown>) => {
        const { response } = await new RPCHandler(createRouter(fixture.deps)).handle(
          new Request(`http://127.0.0.1/rpc/threads/${path}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ json: { groupId: group.id, ...json } }),
          }),
          { prefix: "/rpc", context: { actor: fixture.actor } },
        );
        return response!;
      };
      return { ...fixture, first, threadId, card, call };
    }

    it.each(["send", "react"] as const)(
      "hands the screen back to the member that asked for it on a group %s",
      async (path) => {
        const group = await setupGroup();
        const revoke = vi.spyOn(group.sandbox, "setScreenControl");
        const response = await group.call(
          path,
          path === "send"
            ? { text: "@Fixture the code is 1234.", clientNonce: "group-reply" }
            : { messageId: group.card.id, reaction: "👍", clientNonce: "group-thumb" },
        );
        expect(response.status).toBe(200);
        expect(await group.control()).toMatchObject({
          controlHolder: "bot",
          controlRunId: null,
          controlBotId: null,
          controlLeaseId: null,
        });
        expect(revoke).toHaveBeenCalledWith(
          expect.anything(),
          false,
          expect.anything(),
          group.leaseId,
        );
        expect(
          await system.event.findMany({
            where: { runId: group.run.id, type: "computer.takeover.released" },
          }),
        ).toMatchObject([{ payload: { holder: "bot", reason: "done", leaseId: group.leaseId } }]);
        expect(await system.run.findUniqueOrThrow({ where: { id: group.run.id } })).toMatchObject({
          status: "queued",
          checkpoint: "takeover",
        });
      },
    );

    it("keeps the screen when the reply is for a member that is not waiting", async () => {
      const group = await setupGroup();
      const before = await group.control();
      const revoke = vi.spyOn(group.sandbox, "setScreenControl");
      const response = await group.call("send", {
        text: "@Bystander how are you?",
        clientNonce: "group-other-member",
      });
      expect(response.status).toBe(200);
      expect(await group.control()).toEqual(before);
      expect(revoke).not.toHaveBeenCalled();
    });
  });

  it("does not release the takeover of a routine run that the reply does not steer", async () => {
    const fixture = await setup("opened", "routine");
    const before = await fixture.control();
    const revoke = vi.spyOn(fixture.sandbox, "setScreenControl");
    const response = await fixture.send({ clientNonce: "routine-reply" });
    expect(response.status).toBe(200);
    const { json: sent } = await response.json();
    expect(await fixture.control()).toEqual(before);
    expect(revoke).not.toHaveBeenCalled();
    // The reply gets its own run rather than waiting on the routine's takeover request.
    expect(sent.runId).not.toBe(fixture.run.id);
    expect(await system.run.findUniqueOrThrow({ where: { id: sent.runId } })).toMatchObject({
      status: "queued",
      trigger: "user",
    });
    expect(await system.steeringMessage.count({ where: { botId: fixture.bot.id } })).toBe(0);
    expect(
      await system.event.count({
        where: { runId: fixture.run.id, type: "computer.takeover.released" },
      }),
    ).toBe(0);
  });

  it("ends an unopened takeover wait that a reply would otherwise queue behind", async () => {
    const fixture = await setup("unopened", "routine");
    const response = await fixture.send({ clientNonce: "moved-on" });
    expect(response.status).toBe(200);
    const { json: sent } = await response.json();
    expect(sent.runId).not.toBe(fixture.run.id);

    expect(await endWaits([fixture.run.id])).toBe(1);

    expect(await system.run.findUniqueOrThrow({ where: { id: fixture.run.id } })).toMatchObject({
      status: "cancelled",
      error: stuckWorkStatusMessage("waiting_takeover"),
    });
    expect(
      await system.message.findFirstOrThrow({
        where: { threadId: fixture.thread.id, clientNonce: `stuck-expired:${fixture.run.id}` },
      }),
    ).toMatchObject({
      role: "system",
      blocks: [{ kind: "meta", text: stuckWorkStatusMessage("waiting_takeover") }],
    });
    expect(await fixture.control()).toMatchObject({ controlHolder: "none", controlRunId: null });
    const lease = await system.computerExecutionLease.findFirstOrThrow({
      where: { computerId: fixture.computer.id, botId: fixture.bot.id },
    });
    expect(lease.expiresAt.getTime()).toBeLessThanOrEqual(Date.now());
    expect(await system.run.findUniqueOrThrow({ where: { id: sent.runId } })).toMatchObject({
      status: "queued",
    });
  });

  it("keeps a takeover wait the user is on the screen for, even past the timeout", async () => {
    const fixture = await setup("opened", "routine");
    await system.computer.update({
      where: { id: fixture.computer.id },
      data: { controlLeaseExpiresAt: new Date(Date.now() + 2 * TAKEOVER_WAIT_EXPIRE_AFTER_MS) },
    });
    const before = await fixture.control();
    expect(await endWaits([fixture.run.id])).toBe(0);
    const run = await system.run.findUniqueOrThrow({ where: { id: fixture.run.id } });
    const expired = await runAsSystem("test expiry", () =>
      prisma.$transaction((tx) =>
        expireStuckRun(tx, {
          runId: run.id,
          threadId: run.threadId,
          status: "waiting_takeover",
          updatedAt: run.updatedAt,
          now: new Date(run.updatedAt.getTime() + TAKEOVER_WAIT_EXPIRE_AFTER_MS),
        }),
      ),
    );
    expect(expired).toBeNull();
    expect(await system.run.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({
      status: "waiting_takeover",
    });
    expect(await fixture.control()).toEqual(before);
  });

  it("keeps a taken wait whose screen time ran out until the release resumes it", async () => {
    const fixture = await setup("opened", "routine");
    await system.computer.update({
      where: { id: fixture.computer.id },
      data: { controlLeaseExpiresAt: new Date(Date.now() - 1_000) },
    });
    expect(await endWaits([fixture.run.id])).toBe(0);
    // The expiry job is midway: input denied, provider revocation still pending.
    await system.computer.update({
      where: { id: fixture.computer.id },
      data: { controlHolder: "none" },
    });
    expect(await endWaits([fixture.run.id])).toBe(0);
    expect(await system.run.findUniqueOrThrow({ where: { id: fixture.run.id } })).toMatchObject({
      status: "waiting_takeover",
    });
  });

  it("refuses a takeover grant that races the end of the wait", async () => {
    const fixture = await setup("unopened");
    const response = await fixture.takeover(() => endWaits([fixture.run.id]));
    expect(response.status).toBe(409);
    expect(await system.run.findUniqueOrThrow({ where: { id: fixture.run.id } })).toMatchObject({
      status: "cancelled",
    });
    expect(await fixture.control()).toMatchObject({
      controlHolder: "none",
      controlLeaseId: null,
      controlRunId: null,
    });
  });

  it("does not end a wait once the user's takeover grant lands first", async () => {
    const fixture = await setup("unopened");
    expect((await fixture.takeover()).status).toBe(200);
    expect(await fixture.control()).toMatchObject({
      controlHolder: "user",
      controlRunId: fixture.run.id,
    });
    expect(await endWaits([fixture.run.id])).toBe(0);
    expect(await system.run.findUniqueOrThrow({ where: { id: fixture.run.id } })).toMatchObject({
      status: "waiting_takeover",
    });
  });

  it("releases a takeover the user opens while the release is in flight", async () => {
    const fixture = await setup("unopened");
    const finalize = fixture.events.finalizeComputerControlRelease;
    vi.spyOn(fixture.events, "finalizeComputerControlRelease").mockImplementationOnce(
      async (input) => {
        await system.computer.update({
          where: { id: fixture.computer.id },
          data: {
            controlHolder: "user",
            controlBotId: fixture.bot.id,
            controlRunId: fixture.run.id,
            controlLeaseId: randomUUID(),
            controlLeaseExpiresAt: new Date(Date.now() + 60_000),
          },
        });
        return finalize(input);
      },
    );
    const revoke = vi.spyOn(fixture.sandbox, "setScreenControl");
    expect((await fixture.send({ clientNonce: "opened-meanwhile" })).status).toBe(200);
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(await fixture.control()).toMatchObject({
      controlHolder: "bot",
      controlLeaseId: null,
      controlRunId: null,
    });
    expect(
      await system.event.count({
        where: { runId: fixture.run.id, type: "computer.takeover.released" },
      }),
    ).toBe(1);
    expect(fixture.queuedStates).toContainEqual(
      expect.objectContaining({ status: "queued", checkpoint: "takeover" }),
    );
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
      await system.message.count({
        where: { threadId: fixture.thread.id, clientNonce: "retry-reply" },
      }),
    ).toBe(1);
    expect(await system.steeringMessage.count({ where: { runId: fixture.run.id } })).toBe(1);
    expect(
      await system.event.count({
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
    await system.steeringMessage.updateMany({
      where: { runId: fixture.run.id },
      data: { claimedAt: new Date() },
    });
    await system.run.update({
      where: { id: fixture.run.id },
      data: { status: "waiting_takeover", checkpoint: null },
    });
    await system.computer.update({
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
      await system.event.count({
        where: { runId: fixture.run.id, type: "computer.takeover.released" },
      }),
    ).toBe(1);
  });

  /** Ada's takeover wait from setup() moves into a group where Ben works too. */
  async function groupWithWaitingRun() {
    const { actor, bot: ada, run, computer, sandbox, jobs, deps, control } = await setup();
    const { spaceId, userId } = actor;
    const bot = (name: string) =>
      system.bot.create({
        data: { spaceId, userId, name, color: "test", computerId: computer.id },
      });
    const [ben, cy] = [await bot("Ben"), await bot("Cy")];
    const group = await system.chatGroup.create({
      data: {
        spaceId,
        userId,
        name: "Crew",
        members: { create: [{ botId: ada.id }, { botId: ben.id }, { botId: cy.id }] },
        thread: { create: { spaceId, userId } },
      },
      include: { thread: true },
    });
    const threadId = group.thread!.id;
    await system.task.update({ where: { id: run.taskId }, data: { threadId } });
    await system.run.update({ where: { id: run.id }, data: { threadId } });
    const benTask = await system.task.create({
      data: { spaceId, userId, botId: ben.id, threadId, prompt: "Sign in.", status: "running" },
    });
    const benRun = await system.run.create({
      data: {
        spaceId,
        userId,
        botId: ben.id,
        threadId,
        taskId: benTask.id,
        status: "running",
        trigger: "user",
      },
    });
    const leaseOf = (botId: string) =>
      system.computerExecutionLease.findUniqueOrThrow({
        where: { computerId_botId: { computerId: computer.id, botId } },
      });
    const adaLease = await leaseOf(ada.id);
    const benLease = await system.computerExecutionLease.create({
      data: {
        computerId: computer.id,
        botId: ben.id,
        runId: benRun.id,
        fence: 1,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    const removeAda = { groupId: group.id, botIds: [ben.id, cy.id] };
    const saveFromSettings = async (prismaClient = prisma, route = "update") => {
      const { response } = await new RPCHandler(
        createRouter({ ...deps, prisma: prismaClient }),
      ).handle(
        new Request(`http://127.0.0.1/rpc/groups/${route}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ json: route === "update" ? removeAda : { groupId: group.id } }),
        }),
        { prefix: "/rpc", context: { actor } },
      );
      expect(response?.status).toBe(200);
    };
    const saveFromManager = (prismaClient = prisma) =>
      runAsTenant(actor, () =>
        updateFleetGroup(
          { prisma: prismaClient, events: createThreadEvents(prisma), jobs, sandbox },
          {
            spaceId,
            userId,
            botId: cy.id,
            groupId: null,
            threadId: randomUUID(),
            runId: randomUUID(),
          },
          { ...removeAda, expectedBotIds: [ada.id, ben.id, cy.id] },
        ),
      );
    /** The removed bot's next chat gets the computer now, not when the takeover hold ends. */
    const expectComputerFreed = async () => {
      await expect(
        runAsSystem("test lease", () =>
          acquireComputerExecutionLease(prisma, {
            computerId: computer.id,
            runId: randomUUID(),
            botId: ada.id,
          }),
        ),
      ).resolves.toMatchObject({ fence: 2 });
      // Ben stays in the group, so his run keeps its computer.
      expect(await leaseOf(ben.id)).toEqual(benLease);
    };
    const groupUpdates = () => system.event.count({ where: { threadId, type: "group.updated" } });
    return {
      providerRef: (await control()).providerRef,
      computer,
      ada,
      run,
      adaLease,
      jobs,
      sandbox,
      saveFromSettings,
      saveFromManager,
      expectComputerFreed,
      groupUpdates,
    };
  }

  it.each(["the group settings", "a manager bot"])(
    "stops and frees the computer of a bot %s removes while it waits for takeover",
    async (path) => {
      const fixture = await groupWithWaitingRun();
      const { ada, run } = fixture;
      const execute = vi.spyOn(fixture.sandbox, "execute");
      const releaseScreen = vi.spyOn(fixture.sandbox, "releaseScreen");

      if (path === "the group settings") {
        // Two saves of the same removal race; only the one that cancels the run tears it down.
        await Promise.all([fixture.saveFromSettings(), fixture.saveFromSettings()]);
      } else {
        await expect(fixture.saveFromManager()).resolves.toMatchObject({ ok: true });
      }

      expect(vi.mocked(fixture.jobs.cancel).mock.calls).toEqual([[runJobKey(run.id)]]);
      expect(execute).toHaveBeenCalledWith(
        expect.objectContaining({ providerRef: fixture.providerRef }),
        expect.objectContaining({ argv: cancelComputerRunWorkArgv(fixture.computer.id, run.id) }),
        expect.anything(),
      );
      expect(releaseScreen).toHaveBeenCalledTimes(1);
      expect(releaseScreen).toHaveBeenCalledWith(
        expect.objectContaining({ providerRef: fixture.providerRef }),
        expect.objectContaining({
          spaceId: ada.spaceId,
          botId: ada.id,
          runId: run.id,
          screenLeaseId: screenLeaseIdForRun(fixture.adaLease, run.id),
          cancelRunWork: true,
        }),
      );
      await fixture.expectComputerFreed();
    },
  );

  it("frees the removed bot's computer even when releasing its screen fails", async () => {
    const fixture = await groupWithWaitingRun();
    vi.spyOn(fixture.sandbox, "releaseScreen").mockRejectedValue(new Error("provider unavailable"));

    await fixture.saveFromSettings();
    await fixture.expectComputerFreed();
  });

  it.each(["update", "archive"])(
    "tears down a group run that takes its computer while groups/%s is saving",
    async (route) => {
      const fixture = await groupWithWaitingRun();
      const { ada, run, computer } = fixture;
      // Ada's run is executing and has not taken its computer yet.
      await system.computerExecutionLease.delete({ where: { id: fixture.adaLease.id } });
      await system.run.update({
        where: { id: run.id },
        data: {
          status: "running",
          leaseOwner: "worker",
          leaseFence: 1,
          leaseExpiresAt: new Date(Date.now() + 60_000),
        },
      });
      const releaseScreen = vi.spyOn(fixture.sandbox, "releaseScreen");
      let executorAcquire: unknown;

      await fixture.saveFromSettings(
        afterFirstRead(prisma, "computerExecutionLease", async () => {
          executorAcquire = await runAsSystem("test lease", () =>
            acquireComputerExecutionLease(prisma, {
              computerId: computer.id,
              runId: run.id,
              botId: ada.id,
              workerId: "worker",
              runFence: 1,
            }),
          ).catch((error: unknown) => error);
        }),
        route,
      );

      // Either the save kept the run off the computer, or it tore that computer down.
      const tornDown = releaseScreen.mock.calls.some(([, context]) => context.runId === run.id);
      expect(executorAcquire instanceof ComputerBusyError || tornDown).toBe(true);
    },
  );

  it.each(["update", "archive"])(
    "keeps the failure of a group run that ends while groups/%s is saving",
    async (route) => {
      const fixture = await groupWithWaitingRun();
      const attempt = await system.attempt.create({
        data: { runId: fixture.run.id, fence: 1, status: "running" },
      });
      const run = await system.run.update({
        where: { id: fixture.run.id },
        data: { status: "running", leaseOwner: "worker", leaseFence: 1 },
      });
      const releaseScreen = vi.spyOn(fixture.sandbox, "releaseScreen");

      // The run fails after the save read it as active and before the save cancels it.
      await fixture.saveFromSettings(
        afterFirstRead(prisma, "run", () =>
          runAsSystem("test worker", () =>
            createThreadEvents(prisma).finalizeRun({
              spaceId: run.spaceId,
              threadId: run.threadId,
              botId: run.botId,
              runId: run.id,
              taskId: run.taskId,
              attemptId: attempt.id,
              leaseOwner: "worker",
              leaseFence: 1,
              outcome: "failed",
              error: "The model provider is unavailable.",
            }),
          ),
        ),
        route,
      );

      expect(await system.run.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({
        status: "failed",
        error: "The model provider is unavailable.",
      });
      expect(await system.task.findUniqueOrThrow({ where: { id: run.taskId } })).toMatchObject({
        status: "failed",
      });
      expect(vi.mocked(fixture.jobs.cancel).mock.calls).not.toContainEqual([runJobKey(run.id)]);
      expect(releaseScreen.mock.calls.some(([, context]) => context.runId === run.id)).toBe(false);
    },
  );

  it("still announces a manager bot's group change when freeing the computer fails", async () => {
    const fixture = await groupWithWaitingRun();
    const leaseWriteFails = new Proxy(prisma, {
      get(client, key) {
        if (key === "computerExecutionLease") {
          return {
            updateMany: async () => {
              throw new Error("database unavailable");
            },
          };
        }
        const value = Reflect.get(client, key, client);
        return typeof value === "function" ? value.bind(client) : value;
      },
    });

    await fixture.saveFromManager(leaseWriteFails).catch(() => undefined);
    expect(await fixture.groupUpdates()).toBe(1);
  });
});

/** Runs `before` once, right before the first write that hands the screen to the user. */
function beforeUserGrant(prisma: PrismaClient, before: () => Promise<unknown>): PrismaClient {
  let pending = true;
  const computer = new Proxy(prisma.computer, {
    get(delegate, key) {
      const value = Reflect.get(delegate, key, delegate);
      if (key !== "updateMany") return typeof value === "function" ? value.bind(delegate) : value;
      return async (args: { data?: { controlHolder?: string } }) => {
        if (pending && args.data?.controlHolder === "user") {
          pending = false;
          await before();
        }
        return value.call(delegate, args);
      };
    },
  });
  return new Proxy(prisma, {
    get(client, key) {
      if (key === "computer") return computer;
      const value = Reflect.get(client, key, client);
      return typeof value === "function" ? value.bind(client) : value;
    },
  });
}

/** Runs `after` once, right after the first transaction reads `model`. */
function afterFirstRead(
  prisma: PrismaClient,
  model: "computerExecutionLease" | "run",
  after: () => Promise<unknown>,
): PrismaClient {
  let pending = true;
  const hooked = (tx: Prisma.TransactionClient) => {
    const reads = new Proxy(tx[model], {
      get(delegate, key) {
        const value = Reflect.get(delegate, key, delegate);
        if (key !== "findMany") return typeof value === "function" ? value.bind(delegate) : value;
        return async (args: unknown) => {
          const rows = await value.call(delegate, args);
          if (pending) {
            pending = false;
            await after();
          }
          return rows;
        };
      },
    });
    return new Proxy(tx, {
      get(client, key) {
        if (key === model) return reads;
        const value = Reflect.get(client, key, client);
        return typeof value === "function" ? value.bind(client) : value;
      },
    });
  };
  return new Proxy(prisma, {
    get(client, key) {
      const value = Reflect.get(client, key, client);
      if (key !== "$transaction") return typeof value === "function" ? value.bind(client) : value;
      const transaction = value as (input: unknown, options?: unknown) => Promise<unknown>;
      return (input: unknown, options?: unknown) =>
        transaction.call(
          client,
          typeof input === "function" ? (tx: Prisma.TransactionClient) => input(hooked(tx)) : input,
          options,
        );
    },
  });
}
