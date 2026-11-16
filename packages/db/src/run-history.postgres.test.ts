import type { MessageBlock } from "@rakazo/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "./client.js";
import { createDb } from "./client.js";
import { createThreadMessage, loadRunHistoryMessages } from "./messages.js";
import { provisionMessagingIdentity } from "./messaging.js";
import { asSystem, runAsSystem, runAsTenant } from "./row-security.js";

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
      provisionMessagingIdentity(
        prisma,
        { provider: "sendblue", address },
        { signupsEnabled: undefined, signupAllowlist: undefined },
      ),
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

  it("gives a run that does not know its channel only its waking message and own replies", async () => {
    expect(await history({ sourceMessageId: ids.lostMarker })).toEqual(
      [ids.lostMarker, ids.ownReply].sort(),
    );
  });
});
