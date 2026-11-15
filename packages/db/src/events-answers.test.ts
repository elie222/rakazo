import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";
import { sendUserMessage } from "./events.js";
import type * as ThreadAsk from "./thread-ask.js";
import { answerWaitingRunWithTextInTransaction } from "./thread-ask.js";

vi.mock("./thread-ask.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ThreadAsk>()),
  answerWaitingRunWithTextInTransaction: vi.fn(),
}));

const answer = vi.mocked(answerWaitingRunWithTextInTransaction);

function setup() {
  const tx = {
    $queryRaw: vi.fn(async () => []),
    $executeRaw: vi.fn(async () => 0),
    space: { findUnique: vi.fn() },
    thread: {
      update: vi
        .fn()
        .mockResolvedValueOnce({ nextMessageSeq: 5 })
        .mockResolvedValueOnce({ nextEventSeq: 9 }),
    },
    message: {
      create: vi.fn().mockResolvedValue({ id: "reply-1", seq: 4, createdAt: new Date() }),
      update: vi.fn(),
    },
    task: { create: vi.fn().mockResolvedValue({ id: "task-2" }) },
    run: {
      create: vi.fn().mockResolvedValue({ id: "run-2" }),
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue({ status: "queued" }),
      update: vi.fn(),
    },
    steeringMessage: { create: vi.fn() },
    event: {
      create: vi.fn(async ({ data }: { data: { seq: number; type: string } }) => ({
        id: `event-${data.seq}`,
        spaceId: "space-1",
        threadId: "thread-1",
        botId: "bot-1",
        seq: data.seq,
        type: data.type,
        payload: {},
        createdAt: new Date(),
      })),
    },
  };
  const prisma = {
    message: { findUnique: vi.fn().mockResolvedValue(null) },
    $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
  } as unknown as PrismaClient;
  const send = () =>
    sendUserMessage(prisma, {
      spaceId: "space-1",
      threadId: "thread-1",
      botId: "bot-1",
      userId: "user-1",
      blocks: [{ kind: "text", text: "2" }],
      prompt: "2",
      trigger: "messaging",
      clientNonce: "messaging:sendblue:handle-1",
      answers: { runId: "run-1", messageId: "ask-1", answer: "choice-2" },
    });
  return { tx, send };
}

describe("sendUserMessage answering a question", () => {
  beforeEach(() => {
    answer.mockReset();
  });

  it("answers the question with the message and resumes its run instead of starting one", async () => {
    const t = setup();
    answer.mockResolvedValue({ threadId: "thread-1", seq: 6 });

    await expect(t.send()).resolves.toMatchObject({
      messageId: "reply-1",
      runId: "run-1",
      taskId: null,
    });

    // One eligibility check, which holds the answer to the question it was worked out against.
    expect(answer).toHaveBeenCalledWith(t.tx, {
      spaceId: "space-1",
      threadId: "thread-1",
      runId: "run-1",
      answeredByUserId: "user-1",
      answer: "choice-2",
      beforeMessageSeq: 4,
      answerMessageId: "reply-1",
      questionMessageId: "ask-1",
    });
    expect(t.tx.message.update).toHaveBeenCalledWith({
      where: { id: "reply-1" },
      data: { runId: "run-1" },
    });
    // The resumed run's next reply has not reached the chat yet.
    expect(t.tx.run.update).toHaveBeenCalledWith({
      where: { id: "run-1" },
      data: { messagingMirroredAt: null },
    });
    expect(t.tx.run.create).not.toHaveBeenCalled();
    expect(t.tx.steeringMessage.create).not.toHaveBeenCalled();
    expect(t.tx.event.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ type: "thread.message.created", runId: "run-1" }),
      }),
    );
  });

  it("starts a run as usual when the question no longer takes the answer", async () => {
    const t = setup();
    answer.mockResolvedValue(null);

    await expect(t.send()).resolves.toMatchObject({ runId: "run-2", taskId: "task-2" });
    expect(t.tx.message.update).not.toHaveBeenCalledWith({
      where: { id: "reply-1" },
      data: { runId: "run-1" },
    });
    expect(t.tx.run.update).not.toHaveBeenCalled();
  });
});
