import { describe, expect, it } from "vitest";
import { buildApprovalAskBlock } from "./approval-ask.js";

describe("buildApprovalAskBlock", () => {
  it("shows the complete cross-Space message rather than hiding its ending", () => {
    const message = `${"x".repeat(6000)}VISIBLE END`;
    const block = buildApprovalAskBlock(
      "effect-long",
      "message_bot",
      { target_space_id: "space-b", message },
      [],
      { oneTimeOnly: true },
    );
    if (block.kind !== "ask") throw new Error("expected ask");
    expect(block.detail).toContain(message);
  });
  it("binds the approval to its effect and redacts secrets", () => {
    const block = buildApprovalAskBlock(
      "effect-1",
      "gmail_send_email",
      { to: "person@example.test", body: "token-secret" },
      ["token-secret"],
    );

    expect(block).toMatchObject({
      kind: "ask",
      approvalEffectId: "effect-1",
      actions: [
        { id: "allow", label: "Allow once" },
        { id: "always", label: "Always allow this tool" },
        { id: "deny", label: "Deny" },
      ],
    });
    expect(JSON.stringify(block)).not.toContain("token-secret");
  });

  it("bounds model-controlled summaries and details", () => {
    const block = buildApprovalAskBlock(
      "effect-1",
      "destination.write",
      { title: "t".repeat(1_000), body: "b".repeat(10_000) },
      [],
    );

    expect(block.kind).toBe("ask");
    if (block.kind !== "ask") throw new Error("expected ask block");
    expect(block.text.length).toBeLessThanOrEqual(501);
    expect(block.detail?.length).toBeLessThanOrEqual(4_001);
  });

  it("includes an optional review reason as the first detail line", () => {
    const block = buildApprovalAskBlock(
      "effect-1",
      "gmail_send_email",
      { to: "person@example.test", subject: "Hi" },
      [],
      { reviewReason: "Sends email outside the draft-only task." },
    );

    expect(block.kind).toBe("ask");
    if (block.kind !== "ask") throw new Error("expected ask block");
    expect(block.detail?.startsWith("Sends email outside the draft-only task.")).toBe(true);
    expect(block.detail).toContain("to: person@example.test");
  });

  it("uses a one-time create or cancel choice for a new security boundary", () => {
    const block = buildApprovalAskBlock(
      "effect-1",
      "create_space",
      { name: "Customer support" },
      [],
    );

    expect(block).toMatchObject({
      kind: "ask",
      text: "Create space “Customer support”?",
      actions: [
        { id: "allow", label: "Create space", outcome: "created" },
        { id: "deny", label: "Cancel", outcome: "cancelled" },
      ],
    });
    if (block.kind !== "ask") throw new Error("expected ask block");
    expect(block.detail).toContain("stay separate from other spaces");
  });

  it("shows the exact cross-Space bot destination and payload with no always-allow choice", () => {
    const block = buildApprovalAskBlock(
      "effect-cross-space",
      "message_bot",
      {
        source_space: "Personal",
        source_space_id: "space-source",
        target_space: "Research",
        target_space_id: "space-target",
        bot_id: "bot-target",
        confirm_name: "Analyst",
        intent: "request",
        message: "Review this exact result.",
      },
      [],
      { oneTimeOnly: true },
    );

    expect(block).toMatchObject({
      kind: "ask",
      text: "Review before message_bot from Personal to Research (Analyst)",
      actions: [
        { id: "allow", label: "Allow once" },
        { id: "deny", label: "Deny" },
      ],
      detail: expect.stringContaining("Review this exact result."),
    });
    if (block.kind !== "ask") throw new Error("expected ask block");
    expect(block.detail).toContain("space-target");
    expect(block.detail).toContain("Analyst (bot-target)");
  });
});
