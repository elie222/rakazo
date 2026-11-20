import { describe, expect, it } from "vitest";
import {
  approvalActionName,
  approvalDetailLength,
  buildApprovalAskBlock,
  readableToolName,
  truncate,
} from "./approval-ask.js";

describe("truncate", () => {
  it("does not leave half an emoji before the ellipsis", () => {
    const cut = truncate(`${"a".repeat(9)}😀tail`, 10);
    expect(cut).toBe(`${"a".repeat(9)}…`);
    expect(() => encodeURIComponent(cut)).not.toThrow();
  });
});

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

  it("shows an editable draft only when the full outgoing message fits on the card", () => {
    const args = { channel: "#general", text: "Review the report" };
    const entry = { action: "send", arguments: args };
    const options = {
      allowOutgoingDraft: true,
      batch: {
        items: "tools",
        action: "action",
        arguments: "arguments",
        outgoingDrafts: {
          send: {
            kind: "message" as const,
            source: "Team chat",
            keys: { to: "channel", body: "text" },
          },
        },
      },
    };
    expect(buildApprovalAskBlock("effect", "batch", { tools: [entry] }, [], options)).toMatchObject(
      {
        outgoingDraft: { values: { kind: "message", to: "#general", body: "Review the report" } },
        actions: [
          { id: "allow", label: "Send" },
          { id: "deny", label: "Discard" },
        ],
      },
    );
    expect(
      buildApprovalAskBlock("effect", "batch", { tools: [entry, entry] }, [], options),
    ).not.toHaveProperty("outgoingDraft");
    expect(
      buildApprovalAskBlock("effect", "batch", { tools: [entry] }, ["the report"], options),
    ).not.toHaveProperty("outgoingDraft");
    const attachment = { ...entry, arguments: { ...args, attachment: "example-file" } };
    expect(
      buildApprovalAskBlock("effect", "batch", { tools: [attachment] }, [], options),
    ).not.toHaveProperty("outgoingDraft");
  });

  it("keeps the redacted checker warning on the draft card", () => {
    const block = buildApprovalAskBlock(
      "effect",
      "send_message",
      { channel: "C123", text: "Status update" },
      ["private-name"],
      {
        allowOutgoingDraft: true,
        reviewReason: "This posts to private-name",
        outgoingDraft: {
          kind: "message",
          source: "Team chat",
          keys: { to: "channel", body: "text" },
        },
      },
    );
    expect(block).toHaveProperty("outgoingDraft");
    expect(block).toHaveProperty("detail", expect.stringContaining("This posts to"));
    expect(block).toHaveProperty("detail", expect.not.stringContaining("private-name"));
  });

  it("previews a subject-only email with the recipient alias", () => {
    const outgoingDraft = {
      kind: "email" as const,
      source: "Mail",
      keys: { to: "recipient_email", subject: "subject", body: "body" },
      recipientAlias: "to",
    };
    const args = { to: "sam@example.test", subject: "Review" };
    const options = { outgoingDraft, allowOutgoingDraft: true };
    expect(buildApprovalAskBlock("effect", "send_email", args, [], options)).toMatchObject({
      outgoingDraft: {
        keys: { to: "to" },
        values: { kind: "email", to: args.to, subject: args.subject, body: "" },
      },
    });
    expect(
      buildApprovalAskBlock(
        "effect",
        "send_email",
        { ...args, recipient_email: "other@example.test" },
        [],
        options,
      ),
    ).not.toHaveProperty("outgoingDraft");
  });

  it("offers no Always allow on an approval that asks every time", () => {
    const block = buildApprovalAskBlock(
      "effect-1",
      "schedule_create",
      { name: "Check", prompt: "Summarize changes", watch: { kind: "command", command: "ls" } },
      [],
      { onceOnly: true },
    );

    expect(block).toMatchObject({
      kind: "ask",
      text: "Allow Schedule create?",
      actions: [
        { id: "allow", label: "Allow once" },
        { id: "deny", label: "Deny" },
      ],
    });
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
    expect(block.detail).toContain("To: person@example.test");
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

it("shows the instruction change as a line diff with Apply and Dismiss", () => {
  const block = buildApprovalAskBlock(
    "effect-1",
    "update_bot",
    {
      botId: "bot-1",
      previousInstructions: "Draft only",
      previousInstructionsFromBaseline: true,
      instructions: "Draft only\nAsk before sending",
      reason: "Learned preference",
    },
    [],
  );
  expect(block).toMatchObject({
    kind: "ask",
    detail: "  Draft only\n+ Ask before sending",
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
  // The stored provenance marker is not card copy.
  expect(JSON.stringify(block)).not.toContain("previousInstructionsFromBaseline");
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
      actions:
        toolName === "set_child_instructions"
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

  it("carries a payment's receipt with secrets redacted", () => {
    const block = buildApprovalAskBlock("effect-1", "browser_act", {}, ["fake-token"], {
      summary: {
        onceOnly: true,
        title: "Pay on shop.test?",
        lines: ["Socks: $9.00"],
        receipt: {
          button: "Pay fake-token",
          items: [{ name: "Socks fake-token", amount: "$9.00" }],
          amount: "$9.00",
          amountSource: "page",
        },
      },
    });
    if (block.kind !== "ask") throw new Error("expected ask block");
    expect(block.receipt).toEqual({
      button: "Pay [redacted]",
      items: [{ name: "Socks [redacted]", amount: "$9.00" }],
      amount: "$9.00",
      amountSource: "page",
    });
    expect(block.detail).toBe("Socks: $9.00");
  });

  it("never offers always allow on a tool that needs explicit approval", () => {
    const block = buildApprovalAskBlock(
      "effect-1",
      "set_child_instructions",
      { bot_id: "bot-a" },
      [],
    );
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

describe("approval card arguments", () => {
  const detailOf = (toolName: string, args: Record<string, unknown>) => {
    const block = buildApprovalAskBlock("effect-1", toolName, args, []);
    if (block.kind !== "ask") throw new Error("expected ask block");
    return block.detail ?? "";
  };

  it.each([
    [
      "GMAIL_SEND_EMAIL",
      { recipient_email: "a@example.test", to_email: "b@example.test" },
      "To email: b@example.test",
    ],
    [
      "GOOGLECALENDAR_CREATE_EVENT",
      { summary: "Sync", attendees: ["c@example.test", "d@example.test"] },
      "Attendees: c@example.test, d@example.test",
    ],
    [
      "GMAIL_SEND_EMAIL",
      { to: "a@example.test", extra_recipients: ["e@example.test"] },
      "Extra recipients: e@example.test",
    ],
    ["SLACK_SEND_MESSAGE", { channel: "C-OUTSIDE", text: "Hello" }, "Channel: C-OUTSIDE"],
    [
      "GITHUB_CREATE_AN_ISSUE",
      { owner: "someone-else", repo: "public-repo", title: "Notes" },
      "Repo: public-repo",
    ],
    [
      "SEND_WEBHOOK",
      { destination: { url: "https://hooks.example.test/x" } },
      'Destination: {"url":"https://hooks.example.test/x"}',
    ],
  ])("shows where %s sends", (toolName, args, line) => {
    expect(detailOf(toolName, args).split("\n")).toContain(line);
  });

  it("puts every destination above long text, so none sits below a long body", () => {
    const detail = detailOf("GMAIL_SEND_EMAIL", {
      body: "b".repeat(5_000),
      to: "a@example.test",
      bcc: "hidden@example.test",
    });
    expect(detail.split("\n").slice(0, 2)).toEqual([
      "To: a@example.test",
      "Bcc: hidden@example.test",
    ]);
    expect(detail.length).toBeLessThanOrEqual(4_001);
  });

  it("puts long recipient lists above long text", () => {
    const recipients = Array.from({ length: 40 }, (_, index) => ({
      email: `r${index}@example.test`,
    }));
    const detail = detailOf("SEND_CAMPAIGN", { body: "b".repeat(5_000), recipients });
    expect(detail.startsWith("Recipients: [")).toBe(true);
  });

  it("shows a later batched action's destination above an earlier action's long text", () => {
    const block = buildApprovalAskBlock(
      "effect-1",
      "MULTI_EXECUTE",
      {
        tools: [
          { tool_slug: "DRAFT_POST", arguments: { body: "b".repeat(5_000) } },
          { tool_slug: "GMAIL_SEND_EMAIL", arguments: { to_email: "g@example.test" } },
        ],
      },
      [],
      { batch: { items: "tools", action: "tool_slug", arguments: "arguments" } },
    );
    if (block.kind !== "ask") throw new Error("expected ask block");
    expect(block.detail?.split("\n").slice(0, 3)).toEqual([
      "Draft post",
      "Gmail send email",
      "To email: g@example.test",
    ]);
  });

  it("redacts a secret inside a nested argument even when encoding escapes it", () => {
    const secret = 'p"ss\\word';
    const block = buildApprovalAskBlock(
      "effect-1",
      "CALL_API",
      { headers: { authorization: secret }, to: "h@example.test" },
      [secret],
    );
    if (block.kind !== "ask") throw new Error("expected ask block");
    expect(block.detail).not.toContain("ss");
    expect(block.detail).toContain("To: h@example.test");
  });

  it("shows each batched action's destinations", () => {
    const block = buildApprovalAskBlock(
      "effect-1",
      "MULTI_EXECUTE",
      { tools: [{ tool_slug: "GMAIL_SEND_EMAIL", arguments: { to_email: "f@example.test" } }] },
      [],
      { batch: { items: "tools", action: "tool_slug", arguments: "arguments" } },
    );
    if (block.kind !== "ask") throw new Error("expected ask block");
    expect(block.detail?.split("\n")).toContain("To email: f@example.test");
  });

  it.each([
    ["GMAIL_FETCH_EMAILS", "Gmail fetch emails"],
    ["web_fetch", "Web fetch"],
    ["createIssue", "Create issue"],
    ["mcp__tasklog__add_task", "Tasklog add task"],
  ])("reads the tool name %s as words", (name, words) => {
    expect(readableToolName(name)).toBe(words);
  });

  it("names a repeated batch action once, in words, with how often it runs", () => {
    const query = { query: "verification code newer_than:30d", max_results: 50, verbose: false };
    const entry = { tool_slug: "GMAIL_FETCH_EMAILS", arguments: query };
    const block = buildApprovalAskBlock(
      "effect-1",
      "MULTI_EXECUTE",
      { tools: [entry, entry] },
      [],
      { batch: { items: "tools", action: "tool_slug", arguments: "arguments" } },
    );
    expect(block).toMatchObject({
      text: "Allow Gmail fetch emails?",
      detail:
        "Gmail fetch emails ×2\nQuery: verification code newer_than:30d\nMax results: 50\nVerbose: No",
    });
  });

  it("keeps distinct and separated batch entries apart, in order", () => {
    const entry = (slug: string) => ({ tool_slug: slug, arguments: { id: "1" } });
    const block = buildApprovalAskBlock(
      "effect-1",
      "MULTI_EXECUTE",
      { tools: [entry("SEND_NOTE"), entry("send_note"), entry("ARCHIVE"), entry("SEND_NOTE")] },
      [],
      { batch: { items: "tools", action: "tool_slug", arguments: "arguments" } },
    );
    if (block.kind !== "ask") throw new Error("expected ask block");
    expect(block.detail?.split("\n")).toEqual([
      "Send note",
      "ID: 1",
      "Send note",
      "ID: 1",
      "Archive",
      "ID: 1",
      "Send note",
      "ID: 1",
    ]);
  });

  it("keeps the unknown-action heading on a lone unnamed batch entry", () => {
    const block = buildApprovalAskBlock(
      "effect-1",
      "MULTI_EXECUTE",
      { tools: [{ arguments: { id: "1" } }] },
      [],
      { batch: { items: "tools", action: "tool_slug", arguments: "arguments" } },
    );
    if (block.kind !== "ask") throw new Error("expected ask block");
    expect(block.detail?.split("\n")).toEqual(["…", "ID: 1"]);
  });

  it("keeps entries apart when their unreadable arguments differ", () => {
    const block = buildApprovalAskBlock(
      "effect-1",
      "MULTI_EXECUTE",
      {
        tools: [
          { tool_slug: "SEND_NOTE", arguments: "not json" },
          { tool_slug: "SEND_NOTE", arguments: "[1]" },
        ],
      },
      [],
      { batch: { items: "tools", action: "tool_slug", arguments: "arguments" } },
    );
    if (block.kind !== "ask") throw new Error("expected ask block");
    expect(block.detail?.split("\n")).toEqual(["Send note", "Send note"]);
  });

  it("redacts a secret in a tool name or argument key before rewording it", () => {
    const secret = "SECRET_TOKEN";
    const block = buildApprovalAskBlock("effect-1", `mcp__x__${secret}`, { [secret]: "value" }, [
      secret,
    ]);
    const text = JSON.stringify(block).toLowerCase();
    expect(text).not.toContain("secret token");
    expect(text).not.toContain("secret_token");
  });

  it("still shows a fetch URL when a secret matches an argument name", () => {
    const block = buildApprovalAskBlock(
      "effect-1",
      "web_fetch",
      { url: "https://example.test/page" },
      ["url"],
    );
    if (block.kind !== "ask") throw new Error("expected ask block");
    expect(block.detail).toContain("example.test/page");
  });

  it("names a batch call's actions, not the batch tool, in its alert", () => {
    const batch = { items: "tools", action: "tool_slug", arguments: "arguments" };
    const args = {
      tools: [{ tool_slug: "GMAIL_SEND_EMAIL", arguments: { to: "a@example.test" } }],
    };
    expect(approvalActionName("MULTI_EXECUTE", args, batch, [])).toBe("Gmail send email");
    expect(approvalActionName("web_fetch", { url: "https://a.test" }, undefined, [])).toBe(
      "Web fetch",
    );
  });
});
