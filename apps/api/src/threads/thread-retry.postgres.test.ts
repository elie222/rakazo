import { randomUUID } from "node:crypto";
import { onError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import {
  asSystem,
  createDb,
  createGroupRepos,
  createRepos,
  createThreadEvents,
  createThreadMessage,
  finalizeRun,
  provisionMessagingIdentity,
  runAsSystem,
  runAsTenant,
} from "@rakazo/db";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "../router.js";
import { createRouter } from "../router.js";
import { handleRpcError } from "../rpc-errors.js";

const databaseUrl = process.env.DATABASE_URL;
const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(databaseUrl);

describe.skipIf(!enabled)("threads.retry (PostgreSQL)", () => {
  let prisma: PrismaClient;
  let system: PrismaClient;
  let close: () => Promise<void>;
  let actor: Actor;
  let botId: string;
  let threadId: string;
  let call: (path: string, input: Record<string, unknown>) => Promise<Response>;
  const enqueue = vi.fn().mockResolvedValue(undefined);

  beforeAll(() => {
    const db = createDb(databaseUrl!);
    prisma = db.prisma;
    system = asSystem(prisma);
    close = async () => {
      await prisma.$disconnect();
      await db.pool.end();
    };
  });
  beforeEach(async () => {
    vi.clearAllMocks();
    const identity = await runAsSystem("test fixture", () =>
      provisionMessagingIdentity(prisma, {
        provider: "test",
        address: `thread-retry-${randomUUID()}`,
      }),
    );
    botId = identity.botId;
    actor = { spaceId: identity.spaceId, userId: identity.userId } as Actor;
    threadId = (await system.thread.findFirstOrThrow({ where: { botId } })).id;
    const deps = {
      prisma,
      events: createThreadEvents(prisma),
      jobs: { enqueue, cancel: vi.fn(), close: async () => undefined },
      secrets: { load: vi.fn() },
      sandbox: {},
      env: { agentRuntime: "scripted", deploymentModelConfigured: false },
    } as unknown as RouterDeps;
    // Domain errors answer with their own status, as in the app.
    const handler = new RPCHandler(createRouter(deps), {
      clientInterceptors: [onError((error, { path }) => handleRpcError(error, path))],
    });
    call = async (path, input) => {
      const { response } = await handler.handle(
        new Request(`http://127.0.0.1/rpc/threads/${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ json: input }),
        }),
        { prefix: "/rpc", context: { actor } },
      );
      return response!;
    };
  });
  afterEach(async () => {
    if (!actor) return;
    await system.messagingIdentity.deleteMany({ where: { userId: actor.userId } });
    await system.organization.deleteMany({ where: { id: actor.spaceId } });
    await system.user.deleteMany({ where: { id: actor.userId } });
  });
  afterAll(async () => {
    await close?.();
  });

  /** A typed message whose reply failed. */
  const failedReply = async ({
    trigger = "user",
    retryable = true,
    hasSource = true,
    hasFollowUp = false,
  } = {}) => {
    const message = await createThreadMessage(system, {
      threadId,
      role: "user",
      authorUserId: actor.userId,
      blocks: [{ kind: "text", text: "Summarize the open tickets." }],
    });
    const work = { spaceId: actor.spaceId, botId, threadId, userId: actor.userId };
    const task = await system.task.create({
      data: { ...work, prompt: "Summarize the open tickets.", status: "running" },
    });
    const run = await system.run.create({
      data: {
        ...work,
        taskId: task.id,
        status: "running",
        trigger,
        sourceMessageId: hasSource ? message.id : null,
        leaseOwner: "test-worker",
        leaseFence: 1,
        modelProvider: "openrouter",
        modelId: "openai/gpt-4o",
        modelPinned: true,
      },
    });
    await system.message.update({ where: { id: message.id }, data: { runId: run.id } });
    if (hasFollowUp) {
      await createThreadMessage(system, {
        threadId,
        role: "user",
        authorUserId: actor.userId,
        blocks: [{ kind: "text", text: "Only the urgent tickets." }],
      });
    }
    const attempt = await system.attempt.create({
      data: { runId: run.id, fence: 1, status: "running" },
    });
    await finalizeRun(system, {
      ...work,
      runId: run.id,
      taskId: task.id,
      attemptId: attempt.id,
      leaseOwner: "test-worker",
      leaseFence: 1,
      outcome: "failed",
      error: "terminated",
      retryable,
    });
    return { message, run };
  };
  const retry = async (runId: string) => {
    const response = await call("retry", { botId, runId });
    return { status: response.status, body: (await response.json()) as { json: unknown } };
  };

  const useGroupThread = async () => {
    const group = await runAsTenant(actor, async () => {
      const peer = await createRepos(prisma).createBot(actor, {
        name: "Test peer",
        description: "",
        instructions: "",
        notifyOnFinish: false,
      });
      return createGroupRepos(prisma).createGroup(actor, {
        name: "Test group",
        botIds: [botId, peer.id],
      });
    });
    threadId = (await system.thread.findFirstOrThrow({ where: { groupId: group.id } })).id;
    return group.id;
  };

  it("includes retry eligibility when the chat is opened after the failure", async () => {
    const { run } = await failedReply();
    const response = await call("get", { botId });
    expect(await response.json()).toMatchObject({
      json: { run: { id: run.id, retryable: true } },
    });
  });

  it("drops retry eligibility when someone sends a newer group message", async () => {
    const groupId = await useGroupThread();
    const { run } = await failedReply();
    const before = await call("get", { groupId });
    expect(await before.json()).toMatchObject({ json: { run: { id: run.id, retryable: true } } });
    await createThreadMessage(system, {
      threadId,
      role: "user",
      authorUserId: actor.userId,
      blocks: [{ kind: "text", text: "Next topic." }],
    });
    const response = await call("get", { groupId });
    const body = (await response.json()) as { json: { run: { id: string; retryable?: boolean } } };
    expect(body.json.run.id).toBe(run.id);
    expect(body.json.run.retryable).toBeUndefined();
  });

  it("drops retry eligibility while the failed group member is busy", async () => {
    const groupId = await useGroupThread();
    const { run } = await failedReply();
    const work = { spaceId: actor.spaceId, botId, threadId, userId: actor.userId };
    const task = await system.task.create({
      data: { ...work, prompt: "Run a check.", status: "running" },
    });
    await system.run.create({
      data: { ...work, taskId: task.id, status: "running", trigger: "routine" },
    });
    const response = await call("get", { groupId });
    const body = (await response.json()) as { json: { run: { id: string; retryable?: boolean } } };
    expect(body.json.run.id).toBe(run.id);
    expect(body.json.run.retryable).toBeUndefined();
  });

  it.each([
    ["the run has no source message", { hasSource: false }],
    ["the sender followed up before the failure", { hasFollowUp: true }],
  ] as const)("omits retry eligibility when %s", async (_, options) => {
    const { run } = await failedReply(options);
    const response = await call("get", { botId });
    const body = (await response.json()) as { json: { run: { id: string; retryable?: boolean } } };
    expect(body.json.run.id).toBe(run.id);
    expect(body.json.run.retryable).toBeUndefined();
  });

  it("queues the failed reply again from its original message", async () => {
    const { message, run } = await failedReply();

    const first = await retry(run.id);
    expect(first.status).toBe(200);
    const { runId } = first.body.json as { runId: string };
    const queued = await system.run.findUniqueOrThrow({
      where: { id: runId },
      include: { task: true },
    });
    expect(queued).toMatchObject({
      status: "queued",
      trigger: "user",
      sourceMessageId: message.id,
      retryOfRunId: run.id,
      userId: actor.userId,
      modelProvider: "openrouter",
      modelId: "openai/gpt-4o",
      modelPinned: true,
    });
    expect(queued.task.prompt).toBe("Summarize the open tickets.");
    expect((await system.message.findUniqueOrThrow({ where: { id: message.id } })).runId).toBe(
      runId,
    );
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it("wakes the same queued retry again if a request is repeated", async () => {
    const { run } = await failedReply();
    await retry(run.id);
    await retry(run.id);
    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(enqueue.mock.calls[1]).toEqual(enqueue.mock.calls[0]);
  });

  it("persists one thread refresh signal when the retry is queued", async () => {
    const { run } = await failedReply();
    const receipt = await retry(run.id);
    const { runId } = receipt.body.json as { runId: string };
    await retry(run.id);
    expect(await system.event.findMany({ where: { threadId, type: "thread.meta" } })).toMatchObject(
      [{ runId, payload: { retryQueued: true } }],
    );
  });

  it("returns the existing receipt if teaching starts after the retry was queued", async () => {
    const { run } = await failedReply();
    const receipt = await retry(run.id);
    expect(receipt.status).toBe(200);
    await system.taughtSkill.create({
      data: {
        spaceId: actor.spaceId,
        botId,
        userId: actor.userId,
        goal: "Use the test inbox",
        status: "recording",
      },
    });
    expect(await retry(run.id)).toEqual(receipt);
  });

  it("returns the same retry to concurrent requests", async () => {
    const { run } = await failedReply();
    const pending: Promise<Awaited<ReturnType<typeof retry>>>[] = [];
    // Both requests must reach the thread lock before either can create the retry.
    await system.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM threads WHERE id = ${threadId} FOR UPDATE`;
      pending.push(retry(run.id), retry(run.id));
      await vi.waitFor(
        async () => {
          const [waiting] = await system.$queryRaw<Array<{ count: number }>>`
          SELECT count(*)::int AS count
          FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock'
            AND query LIKE 'SELECT id FROM threads WHERE id = % FOR UPDATE'
        `;
          expect(waiting?.count).toBe(2);
        },
        { timeout: 5_000 },
      );
    });
    const results = await Promise.all(pending);
    expect(results.map((result) => result.status)).toEqual([200, 200]);
    expect(results[0]?.body).toEqual(results[1]?.body);
  });

  it("refuses a failure the worker did not mark as safe to retry", async () => {
    const { run } = await failedReply({ retryable: false });
    expect((await retry(run.id)).status).toBe(409);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("refuses once a newer user message arrives", async () => {
    const { run } = await failedReply();
    await createThreadMessage(system, {
      threadId,
      role: "user",
      authorUserId: actor.userId,
      blocks: [{ kind: "text", text: "Never mind." }],
    });
    expect((await retry(run.id)).status).toBe(409);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("refuses to wake an existing retry that was cancelled", async () => {
    const { run } = await failedReply();
    const receipt = await retry(run.id);
    const { runId } = receipt.body.json as { runId: string };
    await system.run.update({ where: { id: runId }, data: { status: "cancelled" } });
    expect((await retry(run.id)).status).toBe(409);
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it("refuses to retry a routine from the chat banner", async () => {
    const routine = await failedReply({ trigger: "routine" });
    expect((await retry(routine.run.id)).status).toBe(409);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it.each(["running", "waiting_input"])(
    "refuses while the bot has other work %s",
    async (status) => {
      const { run } = await failedReply();
      const work = { spaceId: actor.spaceId, botId, threadId, userId: actor.userId };
      const task = await system.task.create({
        data: { ...work, prompt: "work", status: "queued" },
      });
      await system.run.create({
        data: { ...work, taskId: task.id, status, trigger: "routine" },
      });
      expect((await retry(run.id)).status).toBe(409);
      expect(enqueue).not.toHaveBeenCalled();
    },
  );
});
