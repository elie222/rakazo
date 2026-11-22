import type { AgentRunRequest } from "@rakazo/adapter-kit";
import type { MessageBlock } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import { checkpointAnswerHistory } from "./checkpoint-answer-history.js";
import { messageToAgentHistoryText } from "./reply-context.js";

const run = { id: "run", threadId: "thread", botId: "bot" };
const answer = "Use the garden entrance";
const card = {
  id: "card",
  threadId: "thread",
  role: "bot",
  botId: "bot",
  blocks: [
    {
      kind: "ask",
      text: "Which entrance?",
      status: "answered",
      answer,
      answerMessageId: "answer",
      actions: [
        { id: "a", label: "Front" },
        { id: "b", label: "Back" },
      ],
    },
  ] satisfies MessageBlock[],
};
const reply = {
  id: "answer",
  threadId: "thread",
  role: "user",
  blocks: [{ kind: "text", text: answer }] satisfies MessageBlock[],
};
type Source = Parameters<typeof checkpointAnswerHistory>[3][number];
async function project(messages: Source[], cards = [card], labelled = false) {
  const findMany = vi.fn(async () => cards);
  const history: AgentRunRequest["history"] = messages.map((message) => ({
    id: message.id,
    role: message.role === "bot" ? "assistant" : "user",
    content: messageToAgentHistoryText(message),
  }));
  const result = await checkpointAnswerHistory(
    { message: { findMany } } as never,
    run,
    history,
    messages,
    labelled,
  );
  expect(findMany).toHaveBeenCalledWith({
    where: { runId: "run", threadId: "thread", botId: "bot", role: "bot" },
    select: { id: true, blocks: true },
  });
  return result;
}

describe("checkpoint answer history", () => {
  it("represents the card and linked reply by id without mutating stored messages", async () => {
    const before = structuredClone([card, reply]);
    const result = await project([card, reply, { ...reply, id: "unrelated" }]);
    expect(result.representedMessageIds).toEqual(["card", "answer"]);
    expect(result.history).toEqual([{ id: "unrelated", role: "user", content: answer }]);
    expect([card, reply]).toEqual(before);
  });

  it("removes a typed choice label when the card stores its canonical choice id", async () => {
    const selectedCard = {
      ...card,
      blocks: card.blocks.map((block) => ({ ...block, answer: "a" })),
    };
    const result = await project(
      [{ ...reply, blocks: [{ kind: "text", text: "Front" }] }],
      [selectedCard],
    );
    expect(result.history).toEqual([]);
    expect(result.representedMessageIds).toContain("answer");
  });

  it("finds the link when the card has aged out of the loaded history", async () => {
    expect((await project([reply])).history).toEqual([]);
  });

  it("keeps a selected reply quote while removing only the answer's own text", async () => {
    const result = await project([
      { ...reply, replyToMessageId: "card", replyQuote: "Which entrance?", replyTo: card },
    ]);
    expect(result.history).toHaveLength(1);
    expect(result.history[0]?.content).toContain('"quotedText":"Which entrance?"');
    expect(result.history[0]?.content).not.toContain(answer);
    expect(result.answerReplyContexts.get("answer")).toContain("Which entrance?");
  });

  it("keeps a reaction and the question it targets without quoting the answered text", async () => {
    const reaction = {
      ...reply,
      id: "reaction",
      blocks: [{ kind: "text", text: "👍" }] satisfies MessageBlock[],
      replyToMessageId: "card",
      replyTo: card,
    };
    const result = await project([card, reply, reaction]);
    expect(result.history).toHaveLength(1);
    expect(result.history[0]?.content).toContain("👍");
    expect(result.history[0]?.content).toContain("Which entrance?");
    expect(result.history[0]?.content).not.toContain(answer);
  });

  it.each([
    { kind: "image", artifactId: "image", name: "entrance.png", mimeType: "image/png" },
    { kind: "file", artifactId: "file", name: "entrance.txt", mimeType: "text/plain", size: 3 },
  ] satisfies MessageBlock[])(
    "preserves a $kind attachment beside an answer",
    async (attachment) => {
      const result = await project([card, { ...reply, blocks: [...reply.blocks, attachment] }]);
      expect(result.history).toHaveLength(1);
      expect(result.history[0]?.content).toContain(attachment.name);
      expect(result.history[0]?.content).not.toContain(answer);
      expect(result.answerReplyContexts.get("answer")).toBe("");
      expect(result.representedMessageIds).not.toContain("answer");
    },
  );

  it("does not discard a linked message whose text differs from the stored answer", async () => {
    const result = await project([{ ...reply, blocks: [{ kind: "text", text: "Edited reply" }] }]);
    expect(result.history[0]?.content).toBe("Edited reply");
    expect(result.answerReplyContexts.size).toBe(0);
  });

  it("leaves cards and answers from other runs unchanged", async () => {
    const result = await project([card, reply], []);
    expect(result.history.map((entry) => entry.content)).toEqual([
      messageToAgentHistoryText(card),
      answer,
    ]);
    expect(result.representedMessageIds).toEqual([]);
  });

  it("retains a selected quote of an earlier answer as deliberate user context", async () => {
    const result = await project([
      { ...reply, replyToMessageId: "card", replyQuote: answer, replyTo: card },
    ]);
    expect(result.history[0]?.content).toContain(`"quotedText":"${answer}"`);
  });
});
