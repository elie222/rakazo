import { describe, expect, it, vi } from "vitest";
import { eligibleWaitingTextAnswer } from "./thread-ask.js";

const pendingAsk = {
  id: "ask-1",
  seq: 0,
  role: "bot",
  runId: "run-1",
  blocks: [{ kind: "ask", text: "Which city?", status: "pending" }],
};
const statusBlock = {
  kind: "bot_message_sent",
  toBotId: "supervisor",
  toBotName: "Supervisor",
  text: "Paused until the user responds in my chat: Which city?",
  intent: "status",
};
const statusEcho = {
  id: "wait-notice",
  seq: 1,
  role: "bot",
  runId: "run-1",
  blocks: [statusBlock],
};

describe("composer answers after a delegated wait notice", () => {
  it.each([
    { name: "the same run's status echo", latest: statusEcho, eligible: true },
    { name: "another run's echo", latest: { ...statusEcho, runId: "other-run" }, eligible: false },
    { name: "an echo without a run", latest: { ...statusEcho, runId: null }, eligible: false },
    { name: "a user message", latest: { ...statusEcho, role: "user" }, eligible: false },
    {
      name: "an ordinary bot message",
      latest: { ...statusEcho, blocks: [{ kind: "text", text: "New topic" }] },
      eligible: false,
    },
    ...["request", "question", "result", "fyi"].map((intent) => ({
      name: `a ${intent} echo`,
      latest: { ...statusEcho, blocks: [{ ...statusBlock, intent }] },
      eligible: false,
    })),
    {
      name: "an echo with other content",
      latest: { ...statusEcho, blocks: [statusBlock, { kind: "text", text: "New topic" }] },
      eligible: false,
    },
    {
      name: "an echo with a dropped block",
      latest: { ...statusEcho, blocks: [statusBlock, { text: "Not a block" }] },
      eligible: false,
    },
    {
      name: "a malformed status block",
      latest: { ...statusEcho, blocks: [{ kind: "bot_message_sent", intent: "status" }] },
      eligible: false,
    },
  ])(
    "only skips $name when it is a valid same-run status ($eligible)",
    async ({ latest, eligible }) => {
      const tx = {
        message: {
          findMany: vi.fn(async () => [pendingAsk]),
          findFirst: vi.fn(async ({ where }: { where: { seq: { lt: number } } }) =>
            where.seq.lt === 2 ? latest : pendingAsk,
          ),
        },
      };
      await expect(
        eligibleWaitingTextAnswer(tx as never, {
          spaceId: "space-1",
          threadId: "thread-1",
          runId: "run-1",
          answeredByUserId: "user-1",
          answer: "Paris",
          beforeMessageSeq: 2,
        }),
      ).resolves.toBe(eligible ? "ask-1" : null);
      expect(tx.message.findFirst).toHaveBeenCalledTimes(eligible ? 2 : 1);
    },
  );

  it.each([
    {
      name: "a reaction after the notice",
      intervening: {
        id: "reaction-1",
        seq: 2,
        role: "user",
        runId: null,
        replyToMessageId: "ask-1",
        blocks: [{ kind: "text", text: "❤️" }],
      },
      echoSeq: 1,
      eligible: true,
    },
    {
      name: "a real message before the notice",
      intervening: {
        id: "new-topic",
        seq: 1,
        role: "user",
        runId: null,
        replyToMessageId: null,
        blocks: [{ kind: "text", text: "A new topic" }],
      },
      echoSeq: 2,
      eligible: false,
    },
  ])("respects $name while scanning past the echo", async ({ intervening, echoSeq, eligible }) => {
    const history = [pendingAsk, { ...statusEcho, seq: echoSeq }, intervening];
    const tx = {
      message: {
        findMany: vi.fn(async () => [pendingAsk]),
        findFirst: vi.fn(
          async ({ where }: { where: { seq: { lt: number } } }) =>
            history
              .filter((message) => message.seq < where.seq.lt)
              .sort((a, b) => b.seq - a.seq)[0],
        ),
      },
    };
    await expect(
      eligibleWaitingTextAnswer(tx as never, {
        spaceId: "space-1",
        threadId: "thread-1",
        runId: "run-1",
        answeredByUserId: "user-1",
        answer: "Paris",
        beforeMessageSeq: 3,
      }),
    ).resolves.toBe(eligible ? "ask-1" : null);
  });
});
