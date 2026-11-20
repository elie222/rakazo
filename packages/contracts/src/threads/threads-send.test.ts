import { describe, expect, it } from "vitest";
import { threadSendInput, threadSendWithRoutinesInput } from "./thread-send.js";

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

  it("requires replyToMessageId and nonblank text when answersQuestion is set", () => {
    expect(
      threadSendInput.safeParse({ botId: "bot-1", text: "Kyoto", answersQuestion: true }).success,
    ).toBe(false);
    expect(
      threadSendInput.safeParse({
        botId: "bot-1",
        text: "   ",
        artifactIds: ["artifact-1"],
        replyToMessageId: "ask-1",
        answersQuestion: true,
      }).success,
    ).toBe(false);
    expect(
      threadSendInput.safeParse({
        botId: "bot-1",
        text: "Kyoto",
        replyToMessageId: "ask-1",
        answersQuestion: true,
      }).success,
    ).toBe(true);
  });

  it("keeps answersQuestion out of threadSendWithRoutinesInput", () => {
    expect("answersQuestion" in threadSendWithRoutinesInput.shape).toBe(false);
    const parsed = threadSendWithRoutinesInput.parse({
      botId: "bot-1",
      clientNonce: "nonce-1",
      routineIds: ["routine-1"],
      answersQuestion: true,
    } as Record<string, unknown>);
    expect("answersQuestion" in parsed).toBe(false);
  });
});
