import { os } from "@orpc/server";
import type { VerifiedApiKey } from "@rakazo/auth";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import type { BotAccessDeps } from "./bot-access.js";
import { createBotAccess, presentedApiKey } from "./bot-access.js";

type Bot = { id: string; name: string };

const BOTS: Record<string, Bot[]> = {
  "space-mine": [
    { id: "bot-a", name: "Scout" },
    { id: "bot-b", name: "Twin" },
  ],
  "space-team": [{ id: "bot-c", name: "Twin" }],
  // A Space the caller does not belong to.
  "space-other": [{ id: "bot-x", name: "Private" }],
};
const MEMBER_OF = ["space-mine", "space-team"];

function setup(
  verified: VerifiedApiKey = { ok: true, userId: "user-1", keyId: "key-1" },
  // The task the send names: in a shared Space, another member's run can hold the chat.
  sentTaskId = "task-sent",
  messageRun: { id: string; userId: string; taskId: string } | null = null,
) {
  const listedFor: string[] = [];
  const sentAs: Array<{ actor: Actor; botId: string }> = [];
  const router = os.$context<{ actor: Actor }>().router({
    bots: {
      list: os.$context<{ actor: Actor }>().handler(({ context }) => {
        listedFor.push(context.actor.spaceId);
        return BOTS[context.actor.spaceId] ?? [];
      }),
    },
    threads: {
      head: os.handler(() => ({ threadId: "thread-1", cursor: 7 })),
      send: os.$context<{ actor: Actor }>().handler(({ context, input }) => {
        sentAs.push({ actor: context.actor, botId: (input as { botId: string }).botId });
        return { taskId: sentTaskId, runId: "run-1", seq: 8 };
      }),
    },
  });
  const tasks = [
    { id: "task-1", userId: "user-1", spaceId: "space-mine", botId: "bot-a" },
    { id: "task-sent", userId: "user-1", spaceId: "space-team", botId: "bot-c" },
    { id: "task-next", userId: "user-1", spaceId: "space-mine", botId: "bot-a" },
    { id: "task-peer", userId: "user-2", spaceId: "space-team", botId: "bot-c" },
    { id: "task-own-queued", userId: "user-1", spaceId: "space-team", botId: "bot-c" },
    { id: "task-theirs", userId: "user-2", spaceId: "space-mine", botId: "bot-a" },
  ];
  const at = new Date("2026-11-25T00:00:00Z");
  const callbacks = new Map<string, { url: string; apiKeyId: string }>([
    ["task-1", { url: "https://hooks.example.test/a", apiKeyId: "key-first" }],
  ]);
  const enqueueIn = vi.fn(async () => undefined);
  const prisma = {
    $transaction: async (work: (tx: unknown) => unknown) => work(prisma),
    taskCallback: {
      findUnique: vi.fn(
        async ({ where }: { where: { taskId: string } }) => callbacks.get(where.taskId) ?? null,
      ),
      upsert: vi.fn(
        async ({ create }: { create: { taskId: string; url: string; apiKeyId: string } }) => {
          callbacks.set(create.taskId, { url: create.url, apiKeyId: create.apiKeyId });
        },
      ),
    },
    user: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        where.id === "user-1" ? { email: "user@rakazo.test", deactivatedAt: null } : null,
      ),
    },
    spaceMember: {
      findMany: vi.fn(async () =>
        MEMBER_OF.map((spaceId) => ({ spaceId, space: { name: spaceId } })),
      ),
      findFirst: vi.fn(async ({ where }: { where: { spaceId: string } }) =>
        MEMBER_OF.includes(where.spaceId) ? { spaceId: where.spaceId } : null,
      ),
    },
    task: {
      findFirst: vi.fn(async ({ where }: { where: Record<string, string> }) => {
        const task = tasks.find((row) =>
          Object.entries(where).every(([key, value]) => row[key as keyof typeof row] === value),
        );
        return task && { ...task, createdAt: at, updatedAt: at, runs: [] };
      }),
    },
    message: {
      findMany: vi.fn(async () => []),
      findFirst: vi.fn(async () => (messageRun ? { runId: messageRun.id } : { runId: null })),
    },
    run: {
      findFirst: vi.fn(async ({ where }: { where: { id: string; userId: string } }) =>
        messageRun && messageRun.id === where.id && messageRun.userId === where.userId
          ? { taskId: messageRun.taskId }
          : null,
      ),
    },
  } as unknown as PrismaClient;
  const access = createBotAccess({
    prisma,
    auth: { verifyApiKey: vi.fn(async () => verified) },
    router: router as unknown as BotAccessDeps["router"],
    jobs: { enqueueIn },
    taskCallbackRootKey: "root",
  });
  const caller = { userId: "user-1", email: "user@rakazo.test", keyId: "key-1" };
  return { access, caller, listedFor, sentAs, prisma, callbacks, enqueueIn };
}

const withKey = (value = "rkz_key") => new Headers({ authorization: `Bearer ${value}` });

describe("presentedApiKey", () => {
  it("reads a bearer key, as OpenAI clients send it, or an x-api-key header", () => {
    expect(presentedApiKey(withKey("rkz_abc"))).toBe("rkz_abc");
    expect(presentedApiKey(new Headers({ "x-api-key": "rkz_abc" }))).toBe("rkz_abc");
    expect(presentedApiKey(new Headers())).toBeNull();
  });
});

describe("API key authentication", () => {
  it("refuses a request without a key", async () => {
    const { access } = setup();
    await expect(access.authenticate(new Headers())).rejects.toMatchObject({
      kind: "UNAUTHORIZED",
    });
  });

  it("refuses a key the auth library does not accept", async () => {
    const { access } = setup({ ok: false, reason: "invalid" });
    await expect(access.authenticate(withKey())).rejects.toMatchObject({ kind: "UNAUTHORIZED" });
  });

  it("asks a rate-limited key to wait", async () => {
    const { access } = setup({ ok: false, reason: "rate_limited", retryAfterMs: 29_500 });
    await expect(access.authenticate(withKey())).rejects.toMatchObject({
      kind: "TOO_MANY_REQUESTS",
      retryAfterSeconds: 30,
    });
  });

  it("refuses a key whose account is gone", async () => {
    const { access } = setup({ ok: true, userId: "deleted-user", keyId: "key-1" });
    await expect(access.authenticate(withKey())).rejects.toMatchObject({ kind: "UNAUTHORIZED" });
  });

  it("acts as the key's person", async () => {
    const { access, caller } = setup();
    await expect(access.authenticate(withKey())).resolves.toEqual(caller);
  });
});

describe("bot access", () => {
  it("lists bots only from the Spaces the person belongs to, as that member", async () => {
    const { access, caller, listedFor } = setup();
    const bots = await access.listBots(caller);
    expect(bots.map((bot) => bot.id)).toEqual(["bot-a", "bot-b", "bot-c"]);
    expect(listedFor.sort()).toEqual([...MEMBER_OF].sort());
  });

  it("sends in the bot's own Space, as the person", async () => {
    const { access, caller, sentAs } = setup();
    const { task } = await access.createTask(caller, { bot: "bot-c", text: "Watch for news" });
    expect(sentAs).toEqual([
      {
        actor: expect.objectContaining({ userId: "user-1", spaceId: "space-team" }),
        botId: "bot-c",
      },
    ]);
    expect(task).toMatchObject({ id: "task-sent", status: "working", output: "" });
  });

  it("reports the person's own task when another member's run holds the chat", async () => {
    const queued = setup(undefined, "task-peer", {
      id: "run-own",
      userId: "user-1",
      taskId: "task-own-queued",
    });
    await expect(
      queued.access.createTask(queued.caller, { bot: "bot-c", text: "hi" }),
    ).resolves.toMatchObject({ task: { id: "task-own-queued" } });
    const absorbed = setup(undefined, "task-peer");
    await expect(
      absorbed.access.createTask(absorbed.caller, { bot: "bot-c", text: "hi" }),
    ).rejects.toMatchObject({ kind: "CONFLICT" });
  });

  it("finds a bot by a name only it has, and refuses a shared name", async () => {
    const { access, caller } = setup();
    await expect(access.resolveBot(caller, "scout")).resolves.toMatchObject({ id: "bot-a" });
    await expect(access.resolveBot(caller, "Twin")).rejects.toMatchObject({ kind: "BAD_REQUEST" });
  });

  it("never reaches a bot in a Space the person is not in", async () => {
    const { access, caller, sentAs } = setup();
    for (const ref of ["bot-x", "Private"])
      await expect(access.createTask(caller, { bot: ref, text: "hi" })).rejects.toMatchObject({
        kind: "NOT_FOUND",
      });
    expect(sentAs).toEqual([]);
  });

  it("reports a follow-up's new task to the address the first one used", async () => {
    const { access, caller, callbacks, enqueueIn } = setup(undefined, "task-next");
    const { task } = await access.sendToTask(caller, "task-1", "Keep going");
    expect(task.id).toBe("task-next");
    // Signed with the first callback's key, so the receiver's secret still checks.
    expect(callbacks.get("task-next")).toEqual({
      url: "https://hooks.example.test/a",
      apiKeyId: "key-first",
    });
    expect(enqueueIn).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ name: "task.callback", payload: { taskId: "task-next" } }),
    );
  });

  it("reads only the person's own tasks", async () => {
    const { access, caller } = setup();
    await expect(access.getTask(caller, "task-1")).resolves.toMatchObject({
      task: { id: "task-1", bot_id: "bot-a" },
      cursor: 7,
    });
    await expect(access.getTask(caller, "task-theirs")).rejects.toMatchObject({
      kind: "NOT_FOUND",
    });
  });
});
