import { randomUUID } from "node:crypto";
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
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

const databaseUrl = process.env.DATABASE_URL;
const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(databaseUrl);

describe.skipIf(!enabled)("send model gate with a bot's own model (PostgreSQL)", () => {
  let prisma: PrismaClient;
  let system: PrismaClient;
  let close: () => Promise<void>;
  let actor: Actor;
  let botId: string;
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
      provisionMessagingIdentity(
        prisma,
        { provider: "test", address: `model-gate-${randomUUID()}` },
        { signupsEnabled: undefined, signupAllowlist: undefined },
      ),
    );
    botId = identity.botId;
    actor = { spaceId: identity.spaceId, userId: identity.userId } as Actor;
    // A working connection, but no main model and no deployment model.
    await system.userModelCredential.create({
      data: { userId: actor.userId, provider: "openrouter", label: "Key", secretId: "fixture" },
    });
    const deps = {
      prisma,
      events: createThreadEvents(prisma),
      jobs: { enqueue, cancel: vi.fn(), close: async () => undefined },
      secrets: { load: vi.fn() },
      env: { agentRuntime: "pi", deploymentModelConfigured: false },
    } as unknown as RouterDeps;
    const handler = new RPCHandler(createRouter(deps));
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
    await system.chatGroup.deleteMany({ where: { userId: actor.userId } });
    await system.organization.deleteMany({ where: { id: actor.spaceId } });
    await system.user.deleteMany({ where: { id: actor.userId } });
  });
  afterAll(async () => {
    await close?.();
  });

  const send = (input: Record<string, unknown>) => call("send", input);
  const useModel = (id: string, modelProvider: string | null) =>
    system.bot.update({
      where: { id },
      data: { modelProvider, modelId: modelProvider ? "openai/gpt-4o" : null },
    });
  const expectRefused = async (response: Response) => {
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      json: { message: MODEL_REQUIRED_SEND_ERROR },
    });
  };
  const userMessages = (threadId: string) =>
    system.message.count({ where: { threadId, role: "user" } });
  /** Reacts 👍 to a fresh reply from `author` and returns the runs the reaction started. */
  const react = async (target: Record<string, string>, threadId: string, author: string) => {
    await system.run.updateMany({ where: { threadId }, data: { status: "completed" } });
    const reply = await createThreadMessage(system, {
      threadId,
      role: "bot",
      botId: author,
      blocks: [{ kind: "text", text: "Done." }],
    });
    const response = await call("react", {
      ...target,
      messageId: reply.id,
      reaction: "👍",
      clientNonce: randomUUID(),
    });
    expect(response.status).toBe(200);
    return ((await response.json()) as { json: { runIds: string[] } }).json.runIds;
  };

  it("starts a bot's turn on its own connected model, and refuses one without it", async () => {
    const thread = await system.thread.findFirstOrThrow({ where: { botId } });
    // A bot that follows the main model is still refused.
    await expectRefused(await send({ botId, text: "follows main" }));

    await useModel(botId, "openrouter");
    const accepted = await send({ botId, text: "own model" });
    expect(accepted.status).toBe(200);
    expect(enqueue).toHaveBeenCalled();
    expect(await userMessages(thread.id)).toBe(1);
    // A reaction to its reply starts a turn too.
    expect(await react({ botId }, thread.id, botId)).toHaveLength(1);

    // A provider without a model follows the main model.
    await system.bot.update({ where: { id: botId }, data: { modelId: null } });
    await expectRefused(await send({ botId, text: "no model id" }));
    expect(await react({ botId }, thread.id, botId)).toEqual([]);
    // Its model is set, but no connection serves that provider.
    await useModel(botId, "anthropic");
    await expectRefused(await send({ botId, text: "no connection" }));
    // The connection is gone.
    await useModel(botId, "openrouter");
    await system.userModelCredential.deleteMany({ where: { userId: actor.userId } });
    await expectRefused(await send({ botId, text: "disconnected" }));
    // The accepted send and the two reactions; no refused send was saved.
    expect(await userMessages(thread.id)).toBe(3);
  });

  it("lets a group send through only when every bot it wakes runs its own model", async () => {
    await system.bot.update({ where: { id: botId }, data: { name: "Alpha" } });
    await useModel(botId, "openrouter");
    const beta = await system.bot.create({
      data: { spaceId: actor.spaceId, userId: actor.userId, name: "Beta", color: "primary" },
    });
    const group = await system.chatGroup.create({
      data: {
        spaceId: actor.spaceId,
        userId: actor.userId,
        name: "Group",
        members: { create: [{ botId }, { botId: beta.id }] },
        thread: { create: { spaceId: actor.spaceId, userId: actor.userId } },
      },
      include: { thread: true },
    });

    expect((await send({ groupId: group.id, text: "@Alpha hello" })).status).toBe(200);
    await expectRefused(await send({ groupId: group.id, text: "@Beta hello" }));
    await expectRefused(await send({ groupId: group.id, text: "@everyone hello" }));
    await expectRefused(
      await send({ groupId: group.id, text: "hello", mentions: [{ kind: "bot", id: beta.id }] }),
    );
    expect(await userMessages(group.thread!.id)).toBe(1);
    // A reaction wakes the bot that wrote the message.
    expect(await react({ groupId: group.id }, group.thread!.id, beta.id)).toEqual([]);
    expect(await react({ groupId: group.id }, group.thread!.id, botId)).toHaveLength(1);
  });
});
