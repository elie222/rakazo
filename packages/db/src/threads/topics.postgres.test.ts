import { randomUUID } from "node:crypto";
import { deferred } from "@rakazo/core/test-async";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "../database/client.js";
import { createDb } from "../database/client.js";
import { asSystem, runAsSystem, runAsTenant } from "../database/row-security.js";
import { pruneChatHistory } from "../history/history-retention.js";
import { clearThread } from "./events.js";
import { createThreadMessage } from "./messages.js";
import { markThreadReadFor } from "./thread-reads.js";
import { findTopic, listTopics, openTopic, postTopicItem, settleTopic } from "./topics.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres = process.env.VERIFY_DATABASE && databaseUrl ? describe : describe.skip;

const DAY = 24 * 60 * 60 * 1000;

// Ada has an Inbox bot that posts reports as items, and a second bot whose chat is separate.
describePostgres("topics in a bot chat (PostgreSQL)", () => {
  const suffix = randomUUID();
  const ada = `topics-ada-${suffix}`;
  const organization = `topics-org-${suffix}`;
  const space = `topics-space-${suffix}`;
  let prisma: PrismaClient;
  let close: () => Promise<void>;
  let botId = "";
  let chatId = "";
  let otherChatId = "";
  let runId = "";

  beforeAll(async () => {
    const db = createDb(databaseUrl!);
    prisma = db.prisma;
    close = async () => {
      await prisma.$disconnect();
      await db.pool.end();
    };
    const fixture = asSystem(prisma);
    const now = new Date();
    await fixture.user.create({
      data: { id: ada, name: "Ada", email: `${ada}@example.test`, emailVerified: false },
    });
    await fixture.organization.create({
      data: { id: organization, name: "Topics", slug: organization, createdAt: now },
    });
    await fixture.member.create({
      data: {
        id: randomUUID(),
        organizationId: organization,
        userId: ada,
        role: "owner",
        createdAt: now,
      },
    });
    await fixture.space.create({
      data: { id: space, organizationId: organization, name: "Topics" },
    });
    await fixture.spaceMember.create({
      data: {
        id: randomUUID(),
        organizationId: organization,
        spaceId: space,
        userId: ada,
        role: "owner",
        createdAt: now,
      },
    });
    const inbox = await fixture.bot.create({
      data: {
        spaceId: space,
        userId: ada,
        name: "Inbox",
        color: "blue",
        thread: { create: { spaceId: space, userId: ada } },
      },
      include: { thread: true },
    });
    const other = await fixture.bot.create({
      data: {
        spaceId: space,
        userId: ada,
        name: "Other",
        color: "green",
        thread: { create: { spaceId: space, userId: ada } },
      },
      include: { thread: true },
    });
    botId = inbox.id;
    chatId = inbox.thread!.id;
    otherChatId = other.thread!.id;
    const task = await fixture.task.create({
      data: { spaceId: space, botId, threadId: chatId, userId: ada, prompt: "", status: "running" },
    });
    runId = (
      await fixture.run.create({
        data: {
          spaceId: space,
          botId,
          threadId: chatId,
          taskId: task.id,
          userId: ada,
          status: "running",
          trigger: "routine",
        },
      })
    ).id;
  });

  afterAll(async () => {
    if (!prisma) return;
    await asSystem(prisma).space.deleteMany({ where: { id: space } });
    await asSystem(prisma).organization.deleteMany({ where: { id: organization } });
    await asSystem(prisma).user.deleteMany({ where: { id: ada } });
    await close();
  });

  const as = <T>(fn: () => Promise<T>) => runAsTenant({ spaceId: space, userId: ada }, fn);
  const topics = (now?: Date) =>
    as(() => listTopics(prisma, { mainThreadId: chatId, userId: ada, now }));

  it("lists a posted item as open and unread before anyone replies, once per effect", async () => {
    const post = () =>
      as(() =>
        postTopicItem(prisma, {
          spaceId: space,
          mainThreadId: chatId,
          userId: ada,
          botId,
          runId,
          text: "**#412 Crash on launch**\niPad mini, 3 reports today.",
          effectKey: "effect-412",
        }),
      );
    const first = await post();
    const replay = await post();
    expect(replay.topicId).toBe(first.topicId);
    expect(replay.eventSeq).toBeNull();
    const [item] = await topics();
    expect(item).toMatchObject({
      id: first.topicId,
      rootMessageId: first.messageId,
      title: "#412 Crash on launch",
      item: true,
      replyCount: 0,
      unread: true,
      settledBy: null,
    });
  });

  it("starts a topic on open once, lists it only after a reply, and keeps it to its own chat", async () => {
    const root = await as(() =>
      createThreadMessage(prisma, {
        threadId: chatId,
        role: "bot",
        botId,
        blocks: [{ kind: "text", text: "Weekly summary" }],
      }),
    );
    const topicId = await as(() => openTopic(prisma, { mainThreadId: chatId, messageId: root.id }));
    expect(topicId).toBeTruthy();
    await expect(
      as(() => openTopic(prisma, { mainThreadId: chatId, messageId: root.id })),
    ).resolves.toBe(topicId);
    // A message from another chat cannot be opened through this one, nor its topic found.
    await expect(
      as(() => openTopic(prisma, { mainThreadId: otherChatId, messageId: root.id })),
    ).resolves.toBeNull();
    await expect(
      as(() => findTopic(prisma, { mainThreadId: otherChatId, topicId: topicId! })),
    ).resolves.toBeNull();
    expect((await topics()).some((topic) => topic.id === topicId)).toBe(false);

    await as(() =>
      createThreadMessage(prisma, {
        threadId: topicId!,
        role: "user",
        authorUserId: ada,
        blocks: [{ kind: "text", text: "Can you add last week's numbers?" }],
      }),
    );
    const listed = (await topics()).find((topic) => topic.id === topicId);
    expect(listed).toMatchObject({ title: "Weekly summary", item: false, replyCount: 1 });
  });

  it("settles by hand or from a quiet week once read, and a reopen restarts the week", async () => {
    const item = (await topics()).find((topic) => topic.item);
    const topicId = item!.id;
    // Unread, so a month of quiet still leaves it open.
    const later = new Date(Date.now() + 30 * DAY);
    expect((await topics(later)).find((topic) => topic.id === topicId)?.settledBy).toBeNull();

    await as(() => markThreadReadFor(prisma, { threadId: topicId, spaceId: space, userId: ada }));
    expect((await topics(later)).find((topic) => topic.id === topicId)?.settledBy).toBe("idle");

    await as(() => settleTopic(prisma, { topicId, by: "bot" }));
    expect((await topics()).find((topic) => topic.id === topicId)?.settledBy).toBe("bot");

    const reopenedAt = new Date(Date.now() + 10 * DAY);
    await as(() => settleTopic(prisma, { topicId, by: null, now: reopenedAt }));
    const soon = new Date(reopenedAt.getTime() + 3 * DAY);
    expect((await topics(soon)).find((topic) => topic.id === topicId)?.settledBy).toBeNull();
    const weekOn = new Date(reopenedAt.getTime() + 7 * DAY);
    expect((await topics(weekOn)).find((topic) => topic.id === topicId)?.settledBy).toBe("idle");
  });

  it("keeps an old message while its topic still has recent replies", async () => {
    const system = asSystem(prisma);
    const old = await system.bot.create({
      data: {
        spaceId: space,
        userId: ada,
        name: "Archive",
        color: "gray",
        thread: { create: { spaceId: space, userId: ada } },
      },
      include: { thread: true },
    });
    const root = await as(() =>
      createThreadMessage(prisma, {
        threadId: old.thread!.id,
        role: "bot",
        botId: old.id,
        blocks: [{ kind: "text", text: "Quarterly report" }],
      }),
    );
    await system.message.update({
      where: { id: root.id },
      data: { createdAt: new Date(Date.now() - 40 * DAY) },
    });
    const topicId = await as(() =>
      openTopic(prisma, { mainThreadId: old.thread!.id, messageId: root.id }),
    );
    await as(() =>
      createThreadMessage(prisma, {
        threadId: topicId!,
        role: "user",
        authorUserId: ada,
        blocks: [{ kind: "text", text: "Any update on this?" }],
      }),
    );
    await runAsSystem("test prune", () => pruneChatHistory(system, 30));
    expect(await system.message.findUnique({ where: { id: root.id } })).not.toBeNull();
    expect(await system.thread.findUnique({ where: { id: topicId! } })).not.toBeNull();
  });

  it("clearing the chat stops runs in its topics, including one a send is starting", async () => {
    const system = asSystem(prisma);
    const [topic] = await topics();
    const startRun = async (tx: Pick<PrismaClient, "task" | "run">) => {
      const task = await tx.task.create({
        data: {
          spaceId: space,
          botId,
          threadId: topic!.id,
          userId: ada,
          prompt: "",
          status: "running",
        },
      });
      return tx.run.create({
        data: {
          spaceId: space,
          botId,
          threadId: topic!.id,
          taskId: task.id,
          userId: ada,
          status: "running",
          trigger: "user",
        },
      });
    };
    const working = await startRun(system);
    // A background helper the topic started works in a thread of its own.
    const card = await as(() =>
      createThreadMessage(prisma, {
        threadId: topic!.id,
        role: "bot",
        botId,
        blocks: [{ kind: "text", text: "Checking the crash logs." }],
      }),
    );
    const helperThread = await system.thread.create({
      data: { spaceId: space, userId: ada, helperBotId: botId },
    });
    const helperTask = await system.task.create({
      data: {
        spaceId: space,
        botId,
        threadId: helperThread.id,
        userId: ada,
        prompt: "",
        status: "running",
      },
    });
    const helper = await system.run.create({
      data: {
        spaceId: space,
        botId,
        threadId: helperThread.id,
        taskId: helperTask.id,
        userId: ada,
        status: "running",
        trigger: "helper",
        sourceMessageId: card.id,
      },
    });
    // A send to the topic holds its row, as sends do, while the chat is cleared.
    const locked = deferred();
    const release = deferred();
    const sending = system.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM threads WHERE id = ${topic!.id} FOR UPDATE`;
      const run = await startRun(tx);
      locked.resolve();
      await release.promise;
      return run;
    });
    await locked.promise;
    const clearing = as(() => clearThread(prisma, { spaceId: space, threadId: chatId, botId }));
    // The clear reaches the send's lock before the send commits.
    await vi.waitFor(async () => {
      const [waiting] = await system.$queryRaw<Array<{ count: number }>>`
        SELECT count(*)::int AS count FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'`;
      expect(waiting?.count).toBeGreaterThan(0);
    });
    release.resolve();
    const [started, cleared] = await Promise.all([sending, clearing]);
    expect(cleared.cancelledRunIds).toEqual(
      expect.arrayContaining([working.id, started.id, helper.id]),
    );
    expect(await system.thread.findUnique({ where: { id: topic!.id } })).toBeNull();
  });
});
