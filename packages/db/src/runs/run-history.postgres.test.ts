import type { MessageBlock } from "@rakazo/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "../database/client.js";
import { createDb } from "../database/client.js";
import { asSystem, runAsSystem, runAsTenant } from "../database/row-security.js";
import { provisionMessagingIdentity } from "../messaging/messaging.js";
import { createThreadMessage, loadRunHistoryMessages } from "../threads/messages.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE === "1" && databaseUrl ? describe : describe.skip;

describePostgres("what a run reads of its thread (PostgreSQL)", () => {
  let prisma: PrismaClient;
  let system: PrismaClient;
  let close: () => Promise<void>;
  let provisioned = false;
  let userId: string;
  let spaceId: string;
  let botId: string;
  let threadId: string;
  const address = `+1555${Math.floor(Math.random() * 9_000_000 + 1_000_000)}`;
  const ids: Record<
    "privateAsk" | "privateReply" | "channel" | "otherChannel" | "lostMarker" | "ownReply",
    string
  > = {
    privateAsk: "",
    privateReply: "",
    channel: "",
    otherChannel: "",
    lostMarker: "",
    ownReply: "",
  };
  let runId: string;

  const channelMessage = (channelId: string, text: string): MessageBlock => ({
    kind: "channel_message",
    provider: "sendblue",
    channelId,
    fromAddress: "+15550000001",
    fromLabel: "Pat",
    text,
  });

  beforeAll(async () => {
    const db = createDb(databaseUrl!);
    prisma = db.prisma;
    system = asSystem(prisma);
    close = async () => {
      try {
        await db.prisma.$disconnect();
      } finally {
        await db.pool.end();
      }
    };
    ({ userId, spaceId, botId, threadId } = await runAsSystem("test fixture", () =>
      provisionMessagingIdentity(prisma, { provider: "sendblue", address }),
    ));
    provisioned = true;
    const startRun = async (trigger: string) => {
      const task = await system.task.create({
        data: { spaceId, botId, threadId, userId, prompt: "fixture", status: "running" },
      });
      const run = await system.run.create({
        data: { spaceId, botId, threadId, taskId: task.id, userId, status: "running", trigger },
      });
      return run.id;
    };
    const privateRunId = await startRun("user");
    runId = await startRun("messaging");
    const add = async (role: "user" | "bot", blocks: MessageBlock[], run?: string) => {
      const { id } = await createThreadMessage(system, { threadId, role, blocks, botId });
      if (run) await system.message.update({ where: { id }, data: { runId: run } });
      return id;
    };
    ids.privateAsk = await add("user", [{ kind: "text", text: "My door code is 4821" }]);
    ids.privateReply = await add("bot", [{ kind: "text", text: "Saved." }], privateRunId);
    ids.channel = await add("user", [channelMessage("channel-a", "Lunch at noon?")]);
    ids.otherChannel = await add("user", [channelMessage("channel-b", "Other group")]);
    ids.lostMarker = await add("user", [{ kind: "text", text: "What's new?" }]);
    // The row an older writer left: a group message without its marker, beside a stray entry.
    await system.message.update({
      where: { id: ids.lostMarker },
      data: { blocks: [{ kind: "text", text: "What's new?" }, { text: "no kind" }] },
    });
    ids.ownReply = await add("bot", [{ kind: "text", text: "Working on it" }], runId);
  });

  afterAll(async () => {
    try {
      if (prisma && provisioned) {
        await system.messagingIdentity.deleteMany({ where: { provider: "sendblue", address } });
        await system.organization.deleteMany({ where: { id: spaceId } });
        await system.user.deleteMany({ where: { id: userId } });
      }
    } finally {
      await close?.();
    }
  });

  const history = async (groupTurn?: Parameters<typeof loadRunHistoryMessages>[3]) =>
    (
      await runAsTenant({ spaceId, userId }, () =>
        loadRunHistoryMessages(prisma, { id: runId, threadId, botId, userId }, 100, groupTurn),
      )
    )
      .map((message) => message.id)
      .sort();

  it("gives a private run the whole thread", async () => {
    expect(await history()).toEqual(Object.values(ids).sort());
  });

  it("gives a channel run its channel's messages and its own replies", async () => {
    expect(await history({ channelId: "channel-a" })).toEqual([ids.channel, ids.ownReply].sort());
  });

  it("adds the last reply of each earlier routine run that posted one, however far back", async () => {
    const routine = await system.routine.create({
      data: { spaceId, botId, userId, threadId, name: "Digest", prompt: "Send it", crons: [] },
    });
    let created = Date.now() - 60_000;
    const routineRun = async (status: string) => {
      created += 1_000;
      const task = await system.task.create({
        data: { spaceId, botId, threadId, userId, prompt: "Send it", status },
      });
      return system.run.create({
        data: {
          spaceId,
          botId,
          threadId,
          taskId: task.id,
          userId,
          status,
          trigger: "routine",
          routineId: routine.id,
          createdAt: new Date(created),
        },
      });
    };
    const older = await routineRun("completed");
    const newer = await routineRun("completed");
    // Handed to a working run, or quiet because nothing changed: completed, and posted nothing.
    for (let quiet = 0; quiet < 12; quiet += 1) await routineRun("completed");
    const failed = await routineRun("failed");
    const current = await routineRun("running");
    const posted: string[] = [];
    const reply = async (runId: string, text: string, role: "bot" | "user" = "bot") => {
      const { id } = await createThreadMessage(system, {
        threadId,
        role,
        blocks: [{ kind: "text", text }],
        botId,
        ...(role === "user" ? { authorUserId: userId } : {}),
      });
      posted.push(id);
      if (role === "bot") await system.message.update({ where: { id }, data: { runId } });
      return id;
    };
    const olderResult = await reply(older.id, "Digest: three items");
    await reply(newer.id, "Your helper found four items");
    const newerResult = await reply(newer.id, "Digest: four items");
    await reply(failed.id, "Could not finish");
    const latest = await reply(current.id, "Thanks", "user");
    try {
      const read = await runAsTenant({ spaceId, userId }, () =>
        loadRunHistoryMessages(prisma, current, 1, undefined, {
          routineId: routine.id,
          earlierResults: 2,
        }),
      );
      expect(read.map((message) => message.id)).toEqual([latest, newerResult, olderResult]);
      // Everything else in the chat: messages whose author is not the owner, channel messages,
      // and the bot's replies to them.
      const whole = await runAsTenant({ spaceId, userId }, () =>
        loadRunHistoryMessages(prisma, current, 100, undefined, {
          routineId: routine.id,
          earlierResults: 0,
        }),
      );
      const wholeIds = whole.map((message) => message.id);
      expect(wholeIds).toEqual(expect.arrayContaining([latest, olderResult, ids.privateReply]));
      expect(wholeIds).not.toContain(ids.channel);
      expect(wholeIds).not.toContain(ids.privateAsk);
      // The bot's reply in a turn a connected channel started.
      expect(wholeIds).not.toContain(ids.ownReply);
    } finally {
      await system.message.deleteMany({ where: { id: { in: posted } } });
      await system.run.deleteMany({ where: { routineId: routine.id } });
      await system.routine.delete({ where: { id: routine.id } });
    }
  });

  it("fills a routine's window with what it may read, without others' replies or reply targets", async () => {
    const posted: string[] = [];
    const add = async (
      role: "user" | "bot",
      blocks: unknown[],
      extra: { runId?: string; authorUserId?: string; replyToMessageId?: string } = {},
    ) => {
      const { id } = await createThreadMessage(system, {
        threadId,
        role,
        blocks: [{ kind: "text", text: "placeholder" }],
        botId,
        ...(extra.authorUserId ? { authorUserId: extra.authorUserId } : {}),
      });
      await system.message.update({
        where: { id },
        data: {
          blocks: blocks as never,
          ...(extra.runId ? { runId: extra.runId } : {}),
          ...(extra.replyToMessageId ? { replyToMessageId: extra.replyToMessageId } : {}),
        },
      });
      posted.push(id);
      return id;
    };
    const task = await system.task.create({
      data: { spaceId, botId, threadId, userId, prompt: "fixture", status: "completed" },
    });
    const ownerTurn = await system.run.create({
      data: {
        spaceId,
        botId,
        threadId,
        taskId: task.id,
        userId,
        status: "completed",
        trigger: "user",
      },
    });
    const routineRun = await system.run.create({
      data: {
        spaceId,
        botId,
        threadId,
        taskId: task.id,
        userId,
        status: "running",
        trigger: "routine",
      },
    });
    const text = (body: string) => [{ kind: "text", text: body }];
    const ask = await add("user", text("Plan the launch"), {
      authorUserId: userId,
      replyToMessageId: ids.channel,
    });
    const answer = await add("bot", text("Here is the plan"), { runId: ownerTurn.id });
    // A message whose entries cannot all be read, then a dozen replies to a connected channel.
    await add("user", [{ kind: "text", text: "Fine" }, { text: "no kind" }], {
      authorUserId: userId,
    });
    for (let reply = 0; reply < 12; reply += 1)
      await add("bot", text(`Channel reply ${reply}`), { runId });
    try {
      const read = await runAsTenant({ spaceId, userId }, () =>
        loadRunHistoryMessages(prisma, routineRun, 2, undefined, {
          routineId: "no-routine",
          earlierResults: 0,
        }),
      );
      expect(read.map((message) => message.id)).toEqual([answer, ask]);
      expect(read[1]).toMatchObject({ replyToMessageId: null, replyTo: null, replyQuote: null });
    } finally {
      await system.message.deleteMany({ where: { id: { in: posted } } });
      await system.run.deleteMany({ where: { id: { in: [ownerTurn.id, routineRun.id] } } });
    }
  });

  it("keeps a later delivery out of a run answering an earlier one", async () => {
    const task = await system.task.create({
      data: { spaceId, botId, threadId, userId, prompt: "fixture", status: "running" },
    });
    const deliveryRun = async () =>
      (
        await system.run.create({
          data: {
            spaceId,
            botId,
            threadId,
            taskId: task.id,
            userId,
            status: "running",
            trigger: "webhook",
          },
        })
      ).id;
    const first = await deliveryRun();
    const second = await deliveryRun();
    const posted: string[] = [];
    const post = async (role: "user" | "bot", text: string, run?: string) => {
      const { id } = await createThreadMessage(system, {
        threadId,
        role,
        blocks: [{ kind: "text", text }],
        botId,
      });
      if (run) await system.message.update({ where: { id }, data: { runId: run } });
      posted.push(id);
      return id;
    };
    // The second delivery arrives while the first run works, so it is held under that run's id
    // for display, then gets a run of its own once the first one pauses on an approval.
    const firstDelivery = await post("user", "Bug: the grid sits too far out");
    const firstAsk = await post("bot", "Allow the fetch?", first);
    const secondDelivery = await post("user", "Bug: the composer looks weird", first);
    const secondAsk = await post("bot", "Allow the fetch?", second);
    const firstAnswer = await post("bot", "Triage for the grid", first);
    try {
      const read = (
        await runAsTenant({ spaceId, userId }, () =>
          loadRunHistoryMessages(
            prisma,
            { id: first, threadId, botId, userId },
            100,
            undefined,
            undefined,
            { sourceMessageId: firstDelivery },
          ),
        )
      ).map((message) => message.id);
      expect(read).toEqual(expect.arrayContaining([firstDelivery, firstAsk, firstAnswer]));
      expect(read).not.toContain(secondDelivery);
      expect(read).not.toContain(secondAsk);
    } finally {
      await system.message.deleteMany({ where: { id: { in: posted } } });
      await system.run.deleteMany({ where: { id: { in: [first, second] } } });
    }
  });

  it("gives a run that does not know its channel only its waking message and own replies", async () => {
    expect(await history({ sourceMessageId: ids.lostMarker })).toEqual(
      [ids.lostMarker, ids.ownReply].sort(),
    );
  });
});
