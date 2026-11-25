import { describe, expect, it } from "vitest";
import { threadAnswerQuestionInput, threadSendInput } from "./thread-send.js";

describe("threads.send input bounds", () => {
  it("requires nonblank text or an attachment", () => {
    expect(threadSendInput.safeParse({ botId: "bot-1" }).success).toBe(false);
    expect(threadSendInput.safeParse({ botId: "bot-1", text: "  ", artifactIds: [] }).success).toBe(
      false,
    );
    expect(threadSendInput.safeParse({ botId: "bot-1", artifactIds: ["artifact-1"] }).success).toBe(
      true,
    );
  });

  it("accepts chat text within the length bound", () => {
    const parsed = threadSendInput.safeParse({ botId: "bot-1", text: "a".repeat(100_000) });
    expect(parsed.success).toBe(true);
  });

  it("rejects chat text past the length bound", () => {
    const parsed = threadSendInput.safeParse({ botId: "bot-1", text: "a".repeat(100_001) });
    expect(parsed.success).toBe(false);
  });

  it("requires a reply target, a nonce and nonblank text for a typed card answer", () => {
    const answer = { botId: "bot-1", text: "Kyoto", replyToMessageId: "ask-1", clientNonce: "n-1" };
    expect(threadAnswerQuestionInput.safeParse(answer).success).toBe(true);
    expect(threadAnswerQuestionInput.safeParse({ ...answer, text: "   " }).success).toBe(false);
    expect(
      threadAnswerQuestionInput.safeParse({ ...answer, replyToMessageId: undefined }).success,
    ).toBe(false);
    expect(threadAnswerQuestionInput.safeParse({ ...answer, clientNonce: undefined }).success).toBe(
      false,
    );
  });
});
