import type { MessageBlock } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import {
  attentionActionsForBlock,
  attentionKindForBlock,
  sortAttentionItems,
} from "./attention.js";

const approval: MessageBlock = {
  kind: "ask",
  text: "Read https://docs.example.test/page?q=fixture?",
  status: "pending",
  approvalEffectId: "effect-1",
  site: "docs.example.test",
  actions: [
    { id: "allow", label: "Allow once" },
    { id: "always", label: "Always allow docs.example.test" },
    { id: "deny", label: "Deny" },
  ],
};

const secret: MessageBlock = {
  kind: "ask",
  text: "i need that value in a protected field.",
  status: "pending",
  input: "secret",
};

const choice: MessageBlock = {
  kind: "choice",
  question: "Which city should I use?",
  options: [
    { id: "choice-1", letter: "A", label: "Berlin" },
    { id: "choice-2", letter: "B", label: "Seoul" },
  ],
};

describe("attention cards", () => {
  it("classifies approvals, secrets and questions", () => {
    expect(attentionKindForBlock(approval)).toBe("approval");
    expect(attentionKindForBlock(secret)).toBe("secret");
    expect(attentionKindForBlock(choice)).toBe("question");
    expect(
      attentionKindForBlock({
        kind: "ask",
        text: "Which city?",
        actions: [{ id: "choice-1", label: "Berlin" }],
      }),
    ).toBe("question");
  });

  it("ignores cards that are already answered or dismissed", () => {
    expect(attentionKindForBlock({ ...approval, status: "answered" })).toBeNull();
    expect(attentionKindForBlock({ ...choice, answerId: "choice-1" })).toBeNull();
    expect(attentionKindForBlock({ ...secret, dismissed: true })).toBeNull();
  });

  it("turns answer choices into `threads.answer` actions", () => {
    expect(attentionActionsForBlock(approval)).toEqual([
      { id: "allow", label: "Allow once", answer: "allow", tone: "primary" },
      {
        id: "always",
        label: "Always allow docs.example.test",
        answer: "always",
        tone: "secondary",
      },
      { id: "deny", label: "Deny", answer: "deny", tone: "danger" },
    ]);
    expect(attentionActionsForBlock(choice)).toEqual([
      { id: "choice-1", label: "Berlin", answer: "choice-1", tone: "secondary" },
      { id: "choice-2", label: "Seoul", answer: "choice-2", tone: "secondary" },
    ]);
    expect(
      attentionActionsForBlock({
        kind: "ask",
        text: "Which city?",
        actions: [{ id: "choice-1", label: "Berlin" }],
      }),
    ).toEqual([{ id: "choice-1", label: "Berlin", answer: "choice-1", tone: "secondary" }]);
    expect(attentionActionsForBlock(secret)).toEqual([]);
  });

  it("puts takeovers first, then cards, failures and delayed routines, oldest first", () => {
    const items = [
      { kind: "routine_delayed" as const, createdAt: "2026-01-01T00:00:00.000Z" },
      { kind: "failed" as const, createdAt: "2026-01-02T00:00:00.000Z" },
      { kind: "question" as const, createdAt: "2026-01-03T00:00:00.000Z" },
      { kind: "question" as const, createdAt: "2026-01-04T00:00:00.000Z" },
      { kind: "takeover" as const, createdAt: "2026-01-05T00:00:00.000Z" },
      { kind: "approval" as const, createdAt: "2026-01-02T00:00:00.000Z" },
    ];
    expect(sortAttentionItems(items).map((item) => item.kind)).toEqual([
      "takeover",
      "approval",
      "question",
      "question",
      "failed",
      "routine_delayed",
    ]);
  });
});
