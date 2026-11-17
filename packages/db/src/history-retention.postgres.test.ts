import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "./client.js";
import { createDb } from "./client.js";
import { pruneChatHistory } from "./history-retention.js";
import { provisionMessagingIdentity } from "./messaging.js";
import { asSystem, runAsSystem } from "./row-security.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE === "1" && databaseUrl ? describe : describe.skip;

const DAY_MS = 24 * 60 * 60 * 1000;
// Long before any other test's fixtures: pruning looks at every chat in the shared database.
const NOW = new Date("2024-06-01T00:00:00.000Z");
const daysAgo = (days: number) => new Date(NOW.getTime() - days * DAY_MS);

describePostgres("chat history retention (PostgreSQL)", () => {
  let system: PrismaClient;
  let close: () => Promise<void>;
  let provisioned = false;
  let userId: string;
  let spaceId: string;
  let botId: string;
  let threadId: string;
  const address = `+1555${Math.floor(Math.random() * 9_000_000 + 1_000_000)}`;

  /** Messages 0..ages.length-1, each created that many days ago, and a stored summary. */
  async function seed(ages: number[], cursor: number | null) {
    await system.event.deleteMany({ where: { threadId } });
    await system.message.deleteMany({ where: { threadId } });
    await system.run.deleteMany({ where: { threadId } });
    await system.task.deleteMany({ where: { threadId } });
    await system.message.createMany({
      data: ages.map((age, seq) => ({
        id: `${threadId}-m${seq}`,
        threadId,
        seq,
        role: seq % 2 === 0 ? "user" : "bot",
        blocks: [{ kind: "text", text: `Message ${seq}` }],
        createdAt: daysAgo(age),
      })),
    });
    await system.event.createMany({
      data: ages.map((age, seq) => ({
        spaceId,
        threadId,
        botId,
        seq,
        type: "thread.message.created",
        payload: { messageId: `${threadId}-m${seq}` },
        createdAt: daysAgo(age),
      })),
    });
    await system.thread.update({
      where: { id: threadId },
      data: {
        nextMessageSeq: ages.length,
        nextEventSeq: ages.length,
        historyCompactedUpToSeq: cursor,
        historyCompactionSummary: cursor === null ? null : "Earlier chat summary",
        historyCompactionGeneration: 0,
      },
    });
  }

  async function startRun(status: string) {
    const task = await system.task.create({
      data: { spaceId, botId, threadId, userId, prompt: "work", status },
    });
    return system.run.create({
      data: { spaceId, botId, threadId, taskId: task.id, userId, status, trigger: "user" },
    });
  }

  const seqs = async () =>
    (await system.message.findMany({ where: { threadId }, orderBy: { seq: "asc" } })).map(
      (message) => message.seq,
    );

  const prune = (days = 30) => runAsSystem("test prune", () => pruneChatHistory(system, days, NOW));

  beforeAll(async () => {
    const db = createDb(databaseUrl!);
    system = asSystem(db.prisma);
    close = async () => {
      await db.prisma.$disconnect();
      await db.pool.end();
    };
    ({ userId, spaceId, botId, threadId } = await runAsSystem("test fixture", () =>
      provisionMessagingIdentity(db.prisma, { provider: "sendblue", address }),
    ));
    provisioned = true;
  });

  afterAll(async () => {
    try {
      if (system && provisioned) {
        await system.messagingIdentity.deleteMany({ where: { provider: "sendblue", address } });
        await system.organization.deleteMany({ where: { id: spaceId } });
        await system.user.deleteMany({ where: { id: userId } });
      }
    } finally {
      await close?.();
    }
  });

  it("deletes the old messages and events and keeps the recent ones", async () => {
    await seed([90, 60, 31, 5, 1], null);
    expect(await prune()).toBe(6);
    expect(await seqs()).toEqual([3, 4]);
    expect((await system.event.findMany({ where: { threadId } })).map((e) => e.seq).sort()).toEqual(
      [3, 4],
    );
    const thread = await system.thread.findUniqueOrThrow({ where: { id: threadId } });
    // New messages and events keep counting up from where they were.
    expect(thread).toMatchObject({
      nextMessageSeq: 5,
      nextEventSeq: 5,
      historyCompactedUpToSeq: 2,
    });
  });

  it("deletes an older message that sits behind a newer one only up to the first recent message", async () => {
    // A message created in a late transaction can be stamped before its neighbour; deleting
    // by age alone would leave a hole that compaction cannot read across.
    await seed([90, 5, 89, 1], null);
    await prune();
    expect(await seqs()).toEqual([1, 2, 3]);
    // The old message that stays keeps its event, so lookups of it still find it.
    const events = await system.event.findMany({ where: { threadId } });
    expect(events.map((event) => event.seq).sort()).toEqual([1, 2, 3]);
  });

  it("drops the summary and moves the generation when it covered deleted messages", async () => {
    await seed([90, 60, 31, 5, 1], 1);
    await prune();
    const thread = await system.thread.findUniqueOrThrow({ where: { id: threadId } });
    expect(thread).toMatchObject({
      historyCompactedUpToSeq: 2,
      historyCompactionSummary: null,
      historyCompactionGeneration: 1,
    });
  });

  it("leaves the chat alone while a run is in progress", async () => {
    await seed([90, 60, 5], null);
    const run = await startRun("waiting_input");
    expect(await prune()).toBe(0);
    expect(await seqs()).toEqual([0, 1, 2]);
    await system.run.update({ where: { id: run.id }, data: { status: "completed" } });
    expect(await prune()).toBeGreaterThan(0);
    expect(await seqs()).toEqual([2]);
  });

  it("keeps a message that is still queued behind a run, and what follows it", async () => {
    await seed([90, 80, 70, 5], null);
    const run = await startRun("completed");
    await system.steeringMessage.create({
      data: { messageId: `${threadId}-m1`, botId, userId, runId: run.id },
    });
    await prune();
    expect(await seqs()).toEqual([1, 2, 3]);
  });

  it("does nothing for a chat whose messages are all recent", async () => {
    await seed([5, 1], null);
    expect(await prune()).toBe(0);
    expect(await seqs()).toEqual([0, 1]);
  });
});
