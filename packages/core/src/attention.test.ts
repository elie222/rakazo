import type { MessageBlock } from "@rakazo/contracts";
import { AttentionActionSchema } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import {
  attentionActionsForBlock,
  attentionKindForBlock,
  attentionSectionKey,
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
    expect(attentionKindForBlock(choice)).toBeNull();
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
    expect(attentionActionsForBlock(choice)).toEqual([]);
    expect(
      attentionActionsForBlock({
        kind: "ask",
        text: "Which city?",
        actions: [{ id: "choice-1", label: "Berlin" }],
      }),
    ).toEqual([{ id: "choice-1", label: "Berlin", answer: "choice-1", tone: "secondary" }]);
    expect(attentionActionsForBlock(secret)).toEqual([]);
  });

  it("leaves a payment approval in the chat, where its receipt is visible", () => {
    const payment: MessageBlock = {
      ...approval,
      receipt: {
        items: [{ name: "Coffee", amount: "$4" }],
        amountSource: "page",
        amount: "$4",
      },
    };
    expect(attentionKindForBlock(payment)).toBe("approval");
    expect(attentionActionsForBlock(payment)).toEqual([]);
  });

  it("fits an approval label into the attention action contract", () => {
    const actions = attentionActionsForBlock({
      kind: "ask",
      text: "Read the page",
      status: "pending",
      actions: [{ id: "always", label: `Always allow ${"a".repeat(240)}.example.test` }],
    });
    expect(actions).toHaveLength(1);
    expect(() => AttentionActionSchema.parse(actions[0])).not.toThrow();
    expect(actions[0]!.label.length).toBeLessThanOrEqual(120);
  });

  it("groups kinds into the three inbox sections", () => {
    for (const kind of ["question", "approval", "secret", "takeover"] as const) {
      expect(attentionSectionKey(kind)).toBe("waiting");
    }
    expect(attentionSectionKey("failed")).toBe("failed");
    expect(attentionSectionKey("routine_delayed")).toBe("routines");
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
