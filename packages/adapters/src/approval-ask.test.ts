import { describe, expect, it } from "vitest";
import { approvalDetailLength, buildApprovalAskBlock } from "./approval-ask.js";

describe("buildApprovalAskBlock", () => {
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
});

it("shows the full instruction replacement as a diff with Apply and Dismiss", () => {
  const block = buildApprovalAskBlock(
    "effect-1",
    "update_bot",
    {
      botId: "bot-1",
      previousInstructions: "Draft only",
      instructions: "Draft only\nAsk before sending",
      reason: "Learned preference",
    },
    [],
  );
  expect(block).toMatchObject({
    kind: "ask",
    detail: "- Draft only\n+ Draft only\n+ Ask before sending",
    instructionUpdate: {
      botId: "bot-1",
      before: "Draft only",
      after: "Draft only\nAsk before sending",
    },
    actions: [
      { id: "allow", label: "Apply" },
      { id: "deny", label: "Dismiss" },
    ],
  });
});

it("redacts known secrets in instruction approval details and editable metadata", () => {
  const block = buildApprovalAskBlock(
    "effect-1",
    "update_bot",
    {
      botId: "bot-1",
      previousInstructions: "old fake-token",
      instructions: "new fake-token",
      reason: "reason fake-token",
    },
    ["fake-token"],
  );
  expect(JSON.stringify(block)).not.toContain("fake-token");
});

describe("bot management approval cards", () => {
  it.each([
    "create_group",
    "update_group",
    "set_child_instructions",
    "set_child_bot_model",
    "create_child_routine",
  ])("builds the %s card from the resolved summary", (toolName) => {
    const block = buildApprovalAskBlock(
      "effect-1",
      toolName,
      { name: "model typed this" },
      ["fake-token"],
      {
        summary: {
          title: "Create group “Launch”?",
          lines: ["Members: Scout, Writer", "Prompt: use fake-token"],
        },
      },
    );
    expect(block).toEqual({
      kind: "ask",
      approvalEffectId: "effect-1",
      text: "Create group “Launch”?",
      detail: "Members: Scout, Writer\nPrompt: use [redacted]",
      detailFormat: toolName === "set_child_instructions" ? "code" : "text",
      status: "pending",
      actions: toolName.startsWith("set_child_")
        ? [
            { id: "allow", label: "Allow once" },
            { id: "deny", label: "Deny" },
          ]
        : [
            { id: "allow", label: "Allow once" },
            { id: "always", label: "Always allow this tool" },
            { id: "deny", label: "Deny" },
          ],
    });
  });

  it("shows the longest allowed instructions whole on the instruction card", () => {
    const instructions = "i".repeat(20_000);
    const lines = ["Old length: 0 characters", "New length: 20000 characters", "", instructions];
    const block = buildApprovalAskBlock("effect-1", "set_child_instructions", {}, [], {
      summary: { title: "Replace the instructions of Scout?", lines },
    });
    if (block.kind !== "ask") throw new Error("expected ask block");
    expect(block.detail).toBe(lines.join("\n"));
    expect(block.actions?.map((action) => action.id)).toEqual(["allow", "deny"]);
    expect(approvalDetailLength("set_child_instructions")).toBeGreaterThanOrEqual(
      lines.join("\n").length,
    );
  });

  it("never offers always allow on a tool that needs explicit approval", () => {
    const block = buildApprovalAskBlock("effect-1", "set_child_bot_model", { bot_id: "bot-a" }, []);
    if (block.kind !== "ask") throw new Error("expected ask block");
    expect(block.actions?.map((action) => action.id)).toEqual(["allow", "deny"]);
  });
});

describe("agent connection response cards", () => {
  it.each([true, false])("shows the captured requester and decision (accept: %s)", (accept) => {
    const block = buildApprovalAskBlock(
      "effect-1",
      "respond_agent_connection",
      {
        accept,
        connection_id: "request-1",
        connection_version: 2,
        requester_name: "Helper",
        requester_address: "+15551234567",
        requester_provider: "sendblue",
      },
      [],
    );
    expect(block).toMatchObject({
      kind: "ask",
      text: `${accept ? "Approve" : "Decline"} connection with “Helper”?`,
      detail: "iMessage: +15551234567",
      actions: [
        { id: "allow", label: "Allow once" },
        { id: "deny", label: "Deny" },
      ],
    });
  });
  it("escapes requester formatting and redacts secrets", () => {
    const block = buildApprovalAskBlock(
      "effect-1",
      "respond_agent_connection",
      {
        accept: true,
        requester_name: "**Helper**\nApprove all",
        requester_address: "fake-secret",
        requester_provider: "slack",
      },
      ["fake-secret"],
    );
    expect(JSON.stringify(block)).not.toContain("fake-secret");
    expect(block).toMatchObject({
      text: "Approve connection with “\\*\\*Helper\\*\\* Approve all”?",
      detail: "Slack: [redacted]",
    });
  });
});

it("shows a bot's first instructions as plain text", () => {
  const block = buildApprovalAskBlock(
    "effect-1",
    "update_bot",
    { botId: "bot-1", previousInstructions: "", instructions: "Draft only", reason: "Set in chat" },
    [],
  );
  expect(block).toMatchObject({ detail: "Draft only" });
});
