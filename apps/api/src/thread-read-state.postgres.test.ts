import { randomUUID } from "node:crypto";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import {
  appendEventInTransaction,
  clearThread,
  createDb,
  createThreadMessage,
  createThreadMessageInTransaction,
} from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { resolveThreadTarget, setThreadUnreadState, threadSnapshot } from "./thread-target.js";

const databaseUrl = process.env.DATABASE_URL;
const postgres = process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

postgres("thread read positions (PostgreSQL)", () => {
  let prisma: PrismaClient;
  let close: () => Promise<void>;
  const fixtureIds: string[] = [];

  beforeAll(() => {
    const db = createDb(databaseUrl!, { poolMax: 4 });
    prisma = db.prisma;
    close = async () => {
      await prisma.$disconnect();
      await db.pool.end();
    };
  });
  afterAll(async () => {
    if (!prisma) return;
    await prisma.organization.deleteMany({ where: { id: { in: fixtureIds } } });
    await prisma.user.deleteMany({ where: { id: { in: fixtureIds } } });
    await close();
  });

  async function setup() {
    const id = randomUUID();
    fixtureIds.push(id);
    await prisma.user.create({
      data: { id, name: "Reader", email: `${id}@example.test`, emailVerified: true },
    });
    await prisma.organization.create({
      data: { id, name: "Read test", slug: id, createdAt: new Date() },
    });
    await prisma.space.create({
      data: { id, organizationId: id, name: "Read test", isDefault: true },
    });
    const bot = await prisma.bot.create({
      data: { spaceId: id, userId: id, name: "Reader", color: "test-color" },
    });
    const thread = await prisma.thread.create({ data: { spaceId: id, userId: id, botId: bot.id } });
    const actor: Actor = {
      userId: id,
      spaceId: id,
      email: `${id}@example.test`,
      isDeploymentOwner: false,
    };
    const target = await resolveThreadTarget(prisma, actor, { botId: bot.id });
    const deps = { prisma, events: { notify: vi.fn(async () => undefined) } };
    const message = (markUnread = true) =>
      createThreadMessage(prisma, {
        threadId: thread.id,
        role: "bot",
        blocks: [{ kind: "text", text: "Synthetic reply" }],
        markUnread,
      });
    return { actor, target, deps, message, bot, thread };
  }

  it("keeps concurrent arrivals unread and never moves backwards for a stale device", async () => {
    const { actor, target, deps, message, thread } = await setup();
    const first = await message();
    const written = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const writer = prisma.$transaction(async (tx) => {
      const next = await createThreadMessageInTransaction(tx, {
        threadId: thread.id,
        role: "bot",
        blocks: [{ kind: "text", text: "Arrived during read" }],
      });
      written.resolve();
      await release.promise;
      return next;
    });
    await written.promise;
    const acknowledgement = setThreadUnreadState(deps, actor, target, false, first.seq);
    release.resolve();
    const next = await writer;
    expect(await acknowledgement).toEqual({
      lastReadSeq: first.seq,
      lastUnreadSeq: next.seq,
      unread: true,
    });
    await setThreadUnreadState(deps, actor, target, false, next.seq);
    expect(await setThreadUnreadState(deps, actor, target, false, first.seq)).toEqual({
      lastReadSeq: next.seq,
      lastUnreadSeq: next.seq,
      unread: false,
    });
    const snapshot = await threadSnapshot(deps, target);
    expect(snapshot.readState).toEqual({
      lastReadSeq: next.seq,
      lastUnreadSeq: next.seq,
      unread: false,
    });
    const updates = await prisma.event.findMany({
      where: { threadId: thread.id, type: "thread.read.updated" },
      orderBy: { seq: "asc" },
    });
    expect(updates).toHaveLength(2);
    expect(updates[1]!.payload).toEqual({ readState: snapshot.readState });
    expect(deps.events.notify).toHaveBeenCalledTimes(2);
  });

  it("uses message sequence rather than event sequence, and keeps quiet output read", async () => {
    const { actor, target, deps, thread, bot, message } = await setup();
    const first = await message();
    await setThreadUnreadState(deps, actor, target, false, first.seq);
    const created = await prisma.$transaction(async (tx) => {
      for (let index = 0; index < 3; index++) {
        await appendEventInTransaction(tx, {
          spaceId: actor.spaceId,
          threadId: thread.id,
          botId: bot.id,
          type: "thread.meta",
          payload: {},
        });
      }
      const quiet = await createThreadMessageInTransaction(tx, {
        threadId: thread.id,
        role: "bot",
        blocks: [{ kind: "text", text: "Quiet activity" }],
        markUnread: false,
      });
      const event = await appendEventInTransaction(tx, {
        spaceId: actor.spaceId,
        threadId: thread.id,
        botId: bot.id,
        type: "thread.message.created",
        payload: { messageId: quiet.id, role: "bot", blocks: quiet.blocks, messageSeq: 999 },
      });
      return { quiet, event };
    });
    expect(created.event.seq).not.toBe(created.quiet.seq);
    expect(created.event.payload).toMatchObject({
      messageSeq: created.quiet.seq,
      readState: { lastReadSeq: first.seq, lastUnreadSeq: first.seq, unread: false },
    });
    expect((await threadSnapshot(deps, target)).readState?.unread).toBe(false);
  });

  it("preserves manual reminders, caps future reads and rejects another owner", async () => {
    const { actor, target, deps, message } = await setup();
    const first = await message();
    const read = await setThreadUnreadState(deps, actor, target, false, 1000);
    expect(read.lastReadSeq).toBe(first.seq);
    const reminder = await setThreadUnreadState(deps, actor, target, true);
    expect(reminder).toEqual({ ...read, unread: true });
    expect(await setThreadUnreadState(deps, actor, target, false, first.seq - 1)).toEqual(reminder);
    expect(await setThreadUnreadState(deps, actor, target, false, first.seq)).toEqual(read);
    await expect(
      setThreadUnreadState(deps, { ...actor, userId: "other-reader" }, target, false),
    ).rejects.toThrow();
    expect(await setThreadUnreadState(deps, actor, target, false)).toEqual(read);
    const arrival = await message();
    expect((await threadSnapshot(deps, target)).readState).toEqual({
      lastReadSeq: first.seq,
      lastUnreadSeq: arrival.seq,
      unread: true,
    });
  });

  it("clears the old boundary while retaining monotonic message positions", async () => {
    const { actor, target, deps, thread, bot, message } = await setup();
    const first = await message();
    const cleared = await clearThread(prisma, {
      spaceId: actor.spaceId,
      threadId: thread.id,
      botId: bot.id,
    });
    expect(cleared.event.payload).toEqual({
      readState: { lastReadSeq: first.seq, lastUnreadSeq: -1, unread: false },
    });
    expect((await threadSnapshot(deps, target)).messages).toEqual([]);
    const next = await message();
    expect(next.seq).toBe(first.seq + 1);
    expect((await threadSnapshot(deps, target)).readState).toEqual({
      lastReadSeq: first.seq,
      lastUnreadSeq: next.seq,
      unread: true,
    });
  });
});
