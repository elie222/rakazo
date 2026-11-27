import { randomUUID } from "node:crypto";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import {
  asSystem,
  createDb,
  createThreadEvents,
  createThreadMessage,
  provisionMessagingIdentity,
  runAsSystem,
  runAsTenant,
} from "@rakazo/db";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "../router.js";
import { askFromPage, PageAskNotAllowedError } from "./page-ask.js";

const databaseUrl = process.env.DATABASE_URL;
const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(databaseUrl);

describe.skipIf(!enabled)("asking a page's bot (PostgreSQL)", () => {
  let prisma: PrismaClient;
  let system: PrismaClient;
  let close: () => Promise<void>;
  let actor: Actor;
  let botId: string;
  let deps: RouterDeps;

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
    const identity = await runAsSystem("test fixture", () =>
      provisionMessagingIdentity(prisma, { provider: "test", address: `page-ask-${randomUUID()}` }),
    );
    botId = identity.botId;
    actor = { spaceId: identity.spaceId, userId: identity.userId } as Actor;
    deps = {
      prisma,
      events: createThreadEvents(prisma, undefined, { catchUpMs: 20 }),
      jobs: { enqueue: vi.fn(), cancel: vi.fn(), close: async () => undefined },
      secrets: { load: vi.fn() },
      sandbox: {},
      env: { agentRuntime: "scripted" },
    } as unknown as RouterDeps;
  });
  afterEach(async () => {
    if (!actor) return;
    await system.page.deleteMany({ where: { userId: actor.userId } });
    await system.messagingIdentity.deleteMany({ where: { userId: actor.userId } });
    await system.organization.deleteMany({ where: { id: actor.spaceId } });
    await system.user.deleteMany({ where: { id: actor.userId } });
  });
  afterAll(async () => {
    await close?.();
  });

  const savePage = (abilities: string[]) =>
    system.page.create({
      data: {
        spaceId: actor.spaceId,
        userId: actor.userId,
        botId,
        title: "Plan",
        versions: { create: { version: 1, title: "Plan", source: "", code: "", abilities } },
      },
    });

  it("sends the question into the page's chat and ends with the bot's reply", async () => {
    const page = await savePage(["ask"]);
    const thread = await system.thread.findFirstOrThrow({ where: { botId } });
    // As a signed-in request would, every read runs as this member.
    const events = askFromPage(deps, actor, {
      pageId: page.id,
      text: "Next step?",
      clientNonce: "nonce-0001",
    });
    const next = () => runAsTenant(actor, () => events.next());

    expect(await next()).toEqual({ done: false, value: { kind: "working" } });
    const asked = await system.message.findFirstOrThrow({
      where: { threadId: thread.id, role: "user" },
      select: { blocks: true, runId: true },
    });
    expect(asked.blocks).toEqual([{ kind: "text", text: `[Plan](page:${page.id})\nNext step?` }]);

    const answer = next();
    const reply = await createThreadMessage(system, {
      threadId: thread.id,
      role: "bot",
      botId,
      blocks: [{ kind: "text", text: "Ship the draft." }],
    });
    await system.message.update({ where: { id: reply.id }, data: { runId: asked.runId } });
    await system.run.update({ where: { id: asked.runId! }, data: { status: "completed" } });
    // A finished run writes no more events, so the reply's own change signals the end.
    await runAsTenant(actor, () =>
      deps.events.append({
        spaceId: actor.spaceId,
        threadId: thread.id,
        botId,
        type: "thread.message.updated",
        payload: { messageId: reply.id },
      }),
    );

    expect(await answer).toEqual({
      done: false,
      value: { kind: "answer", text: "Ship the draft." },
    });
    expect((await next()).done).toBe(true);
  });

  it("refuses a page whose saved version does not use askBot, sending nothing", async () => {
    const page = await savePage([]);
    const events = askFromPage(deps, actor, {
      pageId: page.id,
      text: "Next step?",
      clientNonce: "nonce-0002",
    });

    await expect(runAsTenant(actor, () => events.next())).rejects.toBeInstanceOf(
      PageAskNotAllowedError,
    );
    expect(await system.message.count({ where: { thread: { botId }, role: "user" } })).toBe(0);
  });
});
