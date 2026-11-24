import { randomUUID } from "node:crypto";
import { onError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import type { Actor } from "@rakazo/contracts";
import { MODEL_REQUIRED_SEND_ERROR } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import {
  asSystem,
  createDb,
  createThreadEvents,
  createThreadMessage,
  provisionMessagingIdentity,
  runAsSystem,
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
  let env: { agentRuntime: string; deploymentModelConfigured: boolean };

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
    env = { agentRuntime: "scripted", deploymentModelConfigured: false };
    const deps = {
      prisma,
      events: createThreadEvents(prisma),
      jobs: { enqueue, cancel: vi.fn(), close: async () => undefined },
      secrets: { load: vi.fn() },
      sandbox: {},
      env,
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
  const failedReply = async ({ trigger = "user", retryable = true } = {}) => {
    const message = await createThreadMessage(system, {
      threadId,
      role: "user",
      authorUserId: actor.userId,
      blocks: [{ kind: "text", text: "Summarize the open tickets." }],
    });
    const work = { spaceId: actor.spaceId, botId, threadId, userId: actor.userId };
    const task = await system.task.create({
      data: { ...work, prompt: "Summarize the open tickets.", status: "failed" },
    });
    const run = await system.run.create({
      data: {
        ...work,
        taskId: task.id,
        status: "failed",
        trigger,
        error: "terminated",
        sourceMessageId: message.id,
        modelProvider: "openrouter",
        modelId: "openai/gpt-4o",
        modelPinned: true,
      },
    });
    await system.message.update({ where: { id: message.id }, data: { runId: run.id } });
    await createThreadEvents(system).append({
      ...work,
      runId: run.id,
      type: "run.failed",
      payload: { error: "terminated", ...(retryable ? { retryable: true } : {}) },
    });
    return { message, run };
  };
  const retry = async (runId: string) => {
    const response = await call("retry", { botId, runId });
    return { status: response.status, body: (await response.json()) as { json: unknown } };
  };

  it("includes retry eligibility when the chat is opened after the failure", async () => {
    const { run } = await failedReply();
    const response = await call("get", { botId });
    expect(await response.json()).toMatchObject({
      json: { run: { id: run.id, retryable: true } },
    });
  });

  it("queues the failed reply again from its message, once", async () => {
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

    // A second tap returns the same retry instead of starting another turn, and wakes it again
    // in case the first wake was lost.
    const again = await retry(run.id);
    expect(again.status).toBe(200);
    expect(again.body.json).toEqual({ runId });
    expect(await system.run.count({ where: { threadId, retryOfRunId: run.id } })).toBe(1);
    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(enqueue.mock.calls[1]).toEqual(enqueue.mock.calls[0]);

    // A retry that has already ended is still the same receipt and cannot be woken again.
    await system.run.update({ where: { id: runId }, data: { status: "cancelled" } });
    expect(await retry(run.id)).toEqual(first);
    expect(enqueue).toHaveBeenCalledTimes(2);
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

  it("refuses once the conversation moved on or the run was not a typed message", async () => {
    const { run } = await failedReply();
    await createThreadMessage(system, {
      threadId,
      role: "user",
      authorUserId: actor.userId,
      blocks: [{ kind: "text", text: "Never mind." }],
    });
    expect((await retry(run.id)).status).toBe(409);

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

  it("refuses without a model to run on, as a send does", async () => {
    const { run } = await failedReply();
    env.agentRuntime = "pi";
    const refused = await retry(run.id);
    expect(refused.status).toBe(400);
    expect(JSON.stringify(refused.body)).toContain(MODEL_REQUIRED_SEND_ERROR);
    expect(await system.run.count({ where: { retryOfRunId: run.id } })).toBe(0);
  });
});
