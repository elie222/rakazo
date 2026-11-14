import { describe, expect, it, vi } from "vitest";
import type { Prisma } from "./client.js";
import { answerWaitingRunWithTextInTransaction } from "./thread-ask.js";

const ask = (id: string) => ({
  id,
  seq: id === "ask-2" ? 3 : 2,
  role: "bot",
  replyToMessageId: null,
  blocks: [{ kind: "ask", text: "Which day?", status: "pending" }],
});

describe("answerWaitingRunWithTextInTransaction with questionMessageId", () => {
  it("answers nothing once another question is the one a reply answers", async () => {
    const tx = {
      $queryRaw: vi.fn(async () => []),
      message: {
        findMany: vi.fn(async () => [ask("ask-2")]),
        findFirst: vi.fn(async () => ask("ask-2")),
      },
    };

    await expect(
      answerWaitingRunWithTextInTransaction(tx as unknown as Prisma.TransactionClient, {
        spaceId: "space-1",
        threadId: "thread-1",
        runId: "run-1",
        answeredByUserId: "user-1",
        answer: "Monday",
        questionMessageId: "ask-1",
      }),
    ).resolves.toBeNull();
    // Nothing is committed: the run is never locked for the answer.
    expect(tx.$queryRaw).not.toHaveBeenCalled();
  });
});
