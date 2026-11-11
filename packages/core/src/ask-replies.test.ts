import type { MessageBlock } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { separateAskAnswers } from "./ask-replies.js";

const question = (extra: Record<string, unknown> = {}) => ({
  id: "question",
  role: "bot",
  botId: "bot-1",
  blocks: [
    { kind: "ask", text: "What next?", status: "answered", answer: "Build a plan", ...extra },
  ] as MessageBlock[],
});
const reply = (text = "Build a plan", botId = "bot-1") => ({
  id: "reply",
  role: "user",
  botId,
  blocks: [{ kind: "text", text }] as MessageBlock[],
});

describe("separateAskAnswers", () => {
  it("suppresses only an answer also present in the following user message", () => {
    expect([...separateAskAnswers([question(), reply()])]).toEqual([["question", "Build a plan"]]);
    expect(separateAskAnswers([question()]).size).toBe(0);
    expect(separateAskAnswers([reply(), question()]).size).toBe(0);
    expect(separateAskAnswers([question(), reply("Something else")]).size).toBe(0);
    expect(separateAskAnswers([question(), reply("Build a plan", "other-bot")]).size).toBe(0);
  });

  it("keeps approvals, secrets and pending questions visible", () => {
    for (const extra of [
      { approvalEffectId: "effect" },
      { input: "secret" },
      { status: "pending" },
      { instructionUpdate: { after: "Build a plan" } },
    ]) {
      expect(separateAskAnswers([question(extra), reply()]).size).toBe(0);
    }
  });

  it("handles custom choice answers without treating an action id as reply text", () => {
    const actions = [{ id: "choice-1", label: "Build a plan" }];
    expect(separateAskAnswers([question({ actions }), reply()]).size).toBe(1);
    expect(separateAskAnswers([question({ actions, answer: "choice-1" }), reply()]).size).toBe(0);
  });

  it("keeps an answer when another message intervenes", () => {
    expect(
      separateAskAnswers([question(), { id: "later", role: "bot", blocks: [] }, reply()]).size,
    ).toBe(0);
  });
});
