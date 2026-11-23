import type { MessageBlock } from "@rakazo/contracts";
import type { SealedBoxKey } from "@rakazo/core/node/sealed-box";
import { createSealedBoxKey } from "@rakazo/core/node/sealed-box";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PrismaClient } from "../database/client.js";
import { createDb } from "../database/client.js";
import { asSystem, runAsSystem, runAsTenant } from "../database/row-security.js";
import { provisionMessagingIdentity } from "../messaging/messaging.js";
import {
  answerToolQuestion,
  expireRunToolQuestions,
  ToolQuestionAnswerError,
  takeToolQuestionAnswer,
} from "./tool-questions.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE === "1" && databaseUrl ? describe : describe.skip;

const QUESTION = {
  source: "Gateway",
  message: "Allow send_email to run?",
  fields: [
    { name: "approve", label: "Approve", required: true, type: "boolean" as const },
    { name: "note", label: "Note", required: false, type: "text" as const, maxLength: 20 },
  ],
};

describePostgres("tool questions (PostgreSQL)", () => {
  let prisma: PrismaClient;
  let system: PrismaClient;
  let close: () => Promise<void>;
  let provisioned = false;
  let userId: string;
  let spaceId: string;
  let botId: string;
  let threadId: string;
  let runId: string;
  let messageId: string;
  let key: SealedBoxKey;
  const address = `+1555${Math.floor(Math.random() * 9_000_000 + 1_000_000)}`;

  const asOwner = <T>(work: () => Promise<T>) => runAsTenant({ spaceId, userId }, work);
  const ref = () => ({ spaceId, threadId, messageId });
  const card = async () => {
    const message = await system.message.findUniqueOrThrow({ where: { id: messageId } });
    return (message.blocks as MessageBlock[])[0] as Extract<
      MessageBlock,
      { kind: "tool_question" }
    >;
  };
  const answer = (input: { action: "accept" | "decline"; values?: Record<string, unknown> }) =>
    asOwner(() => answerToolQuestion(prisma, { ...ref(), userId, ...input }));

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
  });

  beforeEach(async () => {
    key = createSealedBoxKey();
    const task = await system.task.create({
      data: { spaceId, botId, threadId, userId, prompt: "send the email", status: "running" },
    });
    ({ id: runId } = await system.run.create({
      data: {
        spaceId,
        botId,
        threadId,
        taskId: task.id,
        userId,
        status: "running",
        trigger: "user",
        startedAt: new Date(),
      },
    }));
    const { nextMessageSeq } = await system.thread.update({
      where: { id: threadId },
      data: { nextMessageSeq: { increment: 1 } },
      select: { nextMessageSeq: true },
    });
    const block: MessageBlock = {
      kind: "tool_question",
      question: QUESTION,
      status: "pending",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      publicKey: key.publicKey,
    };
    ({ id: messageId } = await system.message.create({
      data: { threadId, botId, runId, seq: nextMessageSeq - 1, role: "bot", blocks: [block] },
    }));
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

  it("hands an answer sealed to the waiting call's key to that call once", async () => {
    expect(await asOwner(() => takeToolQuestionAnswer(prisma, ref(), { expire: false }))).toEqual({
      answer: undefined,
    });
    const committed = await answer({
      action: "accept",
      values: { approve: true, note: "quiet-hours" },
    });
    expect(committed?.threadId).toBe(threadId);
    const event = await system.event.findFirstOrThrow({ where: { threadId, seq: committed!.seq } });
    // Every reader of the chat (another member of the space included) sees only the box.
    expect(JSON.stringify(event.payload)).not.toContain("quiet-hours");
    expect(JSON.stringify(event.payload)).not.toContain("sealedValues");
    const stored = await card();
    expect(JSON.stringify(stored)).not.toContain("quiet-hours");

    const taken = await asOwner(() => takeToolQuestionAnswer(prisma, ref(), { expire: false }));
    expect(taken.answer?.action).toBe("accept");
    const sealed = (taken.answer as { sealedValues: string }).sealedValues;
    expect(JSON.parse(key.open(sealed)!)).toEqual({ approve: true, note: "quiet-hours" });
    expect(createSealedBoxKey().open(sealed)).toBeUndefined();
    // The box leaves the row as the call reads it; the card keeps only its outcome.
    expect(await card()).toMatchObject({ status: "accepted" });
    expect((await card()).sealedValues).toBeUndefined();
  });

  it("sends a decline", async () => {
    await answer({ action: "decline" });
    expect(
      (await asOwner(() => takeToolQuestionAnswer(prisma, ref(), { expire: false }))).answer,
    ).toEqual({ action: "decline" });
  });

  it("refuses values the form did not ask for, and a missing required field", async () => {
    await expect(answer({ action: "accept", values: { approve: "yes" } })).rejects.toThrow(
      ToolQuestionAnswerError,
    );
    await expect(answer({ action: "accept", values: { note: "hi" } })).rejects.toThrow(
      "Approve is required",
    );
    await expect(answer({ action: "accept", values: { approve: true, extra: 1 } })).rejects.toThrow(
      "Unknown field extra",
    );
    expect((await card()).status).toBe("pending");
  });

  it("lets only the run's own user answer, only while the run is running", async () => {
    await expect(
      asOwner(() =>
        answerToolQuestion(prisma, { ...ref(), userId: "someone-else", action: "decline" }),
      ),
    ).rejects.toThrow("no longer open");
    await system.run.update({ where: { id: runId }, data: { status: "waiting_input" } });
    await expect(answer({ action: "decline" })).rejects.toThrow("no longer open");
    expect((await card()).status).toBe("pending");
  });

  it("closes an unanswered card as expired and refuses a later answer", async () => {
    const taken = await asOwner(() => takeToolQuestionAnswer(prisma, ref(), { expire: true }));
    expect(taken.answer).toEqual({ action: "cancel" });
    expect(taken.seq).toBeTypeOf("number");
    expect((await card()).status).toBe("expired");
    await expect(answer({ action: "decline" })).rejects.toThrow("no longer open");
  });

  it("refuses an answer after the card's wait ran out", async () => {
    await expect(
      asOwner(() =>
        answerToolQuestion(prisma, {
          ...ref(),
          userId,
          action: "decline",
          now: new Date(Date.now() + 120_000),
        }),
      ),
    ).rejects.toThrow("no longer open");
  });

  it("drops an answer its call never took when a new attempt starts", async () => {
    await answer({ action: "accept", values: { approve: true } });
    await asOwner(() => expireRunToolQuestions(prisma, { id: runId, spaceId }, async () => {}));
    expect(await card()).toMatchObject({ status: "accepted" });
    expect((await card()).sealedValues).toBeUndefined();
  });

  it("expires a run's open questions when a new attempt starts after a restart", async () => {
    const notified: number[] = [];
    await asOwner(() =>
      expireRunToolQuestions(prisma, { id: runId, spaceId }, async (thread, seq) => {
        expect(thread).toBe(threadId);
        notified.push(seq);
      }),
    );
    expect((await card()).status).toBe("expired");
    expect(notified).toHaveLength(1);
  });
});
