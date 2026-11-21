import type { ThreadMessage } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { chatTranscriptMarkdown } from "./chat-transcript.js";

let seq = 0;
function message(
  role: ThreadMessage["role"],
  blocks: ThreadMessage["blocks"],
  createdAt = "2026-03-04T10:00:00.000Z",
  extra: Partial<ThreadMessage> = {},
): ThreadMessage {
  seq += 1;
  return { id: `m_${seq}`, threadId: "t_1", seq, role, blocks, createdAt, ...extra };
}

const askWords = {
  answer: "Answer",
  expired: "Expired",
  more: (count: string) => `${count} more`,
  total: "Total",
  onTheButton: "On the button",
  to: "To",
  subject: "Subject",
  updateInstructions: "Update instructions?",
  instructionsUpdated: "Instructions updated",
  settingsUpdated: "Settings updated",
  readFromPage: "Read from the page, not checked",
  buttonReadFromPage: (button: string) => `Button “${button}”. Read from the page, not checked`,
  approved: "Approved",
  discarded: "Discarded",
  commandVariable: "Command variable",
  codeFrom: (host: string) => `Only enter a code ${host} sent you.`,
  answered: "Answered",
  created: "Created",
  cancelled: "Cancelled",
  allowedInSpace: "Allowed in this space",
  allowedOnce: "Allowed once",
  alwaysAllowed: "Always allowed",
  denied: "Denied",
  answeredWith: (answer: string) => `Answered: ${answer}`,
};

const cardStatus = {
  saved: "Saved",
  sent: "Sent",
  dismissed: "Dismissed",
  running: "Running",
  completed: "Completed",
  failed: "Failed",
  stopped: "Stopped",
  archived: "archived",
  deleted: "deleted",
  setupComplete: "Setup complete",
  phoneCall: "Phone call",
  incomingCall: "Incoming call",
  callingYou: "Calling you…",
  missedCall: "Missed call",
  youDeclined: "You declined",
  connected: "Connected",
  declined: "Declined",
  needsYou: "Needs you",
  skipped: "Skipped",
  done: "Done",
  cloudAgent: {
    running: "running",
    finished: "finished",
    failed: "failed",
    cancelled: "cancelled",
    expired: "expired",
  },
};

const cardLabels = {
  computer: "Computer",
  pullRequest: "Pull request",
  connectMcpServer: (name: string) => `Connect MCP server “${name}”`,
  draftSkill: "Draft skill",
  skillName: "Name",
  whenToUse: "When to use",
  inputs: "Inputs",
  steps: "Steps",
  howToCheck: "How to check",
  whatToReturn: "What to return",
  approvalBoundaries: "Approval boundaries",
  failureHandling: "Failure handling",
};

const transcript = (messages: ThreadMessage[]) =>
  chatTranscriptMarkdown({
    title: "Ada",
    messages,
    speaker: (item) => (item.role === "user" ? "You" : "Ada"),
    time: (createdAt) => createdAt.slice(0, 16).replace("T", " "),
    routineEvent: (change, name) => `${change} routine "${name}"`,
    askWords,
    cardStatus,
    cardLabels,
    memberName: (botId: string) => botId,
    attachment: "Attachment",
    isSetupComplete: () => false,
  });

describe("chatTranscriptMarkdown", () => {
  it("writes each message under who said it and when, in the order given", () => {
    expect(
      transcript([
        message("user", [{ kind: "text", text: "Summarize my inbox" }], "2026-03-04T10:00:00.000Z"),
        message(
          "bot",
          [{ kind: "text", text: "Three need a reply.\n\n- Dana\n- Lee" }],
          "2026-03-04T10:01:00.000Z",
        ),
      ]),
    ).toBe(
      [
        "# Ada",
        "**You** · 2026-03-04 10:00\n\nSummarize my inbox",
        "**Ada** · 2026-03-04 10:01\n\nThree need a reply.\n\n- Dana\n- Lee",
      ].join("\n\n---\n\n") + "\n",
    );
  });

  it("names attached files and images, and keeps a message that is only an attachment", () => {
    const text = transcript([
      message("user", [
        { kind: "text", text: "Here you go" },
        { kind: "image", artifactId: "a_1", mimeType: "image/png", name: "chart.png" },
        { kind: "file", artifactId: "a_2", mimeType: "text/csv", name: "q1.csv", size: 12 },
      ]),
      message("bot", [
        { kind: "file", artifactId: "a_3", mimeType: "text/csv", name: "out.csv", size: 4 },
      ]),
    ]);
    expect(text).toContain("Here you go\n\nAttachment: chart.png\n\nAttachment: q1.csv");
    expect(text).toContain("**Ada** · 2026-03-04 10:00\n\nAttachment: out.csv");
  });

  it("leaves out what the chat does not show as a message", () => {
    const text = transcript([
      message("bot", [{ kind: "delivery" }]),
      message("bot", [{ kind: "steps", steps: [] }]),
      message("bot", [{ kind: "text", text: "   " }]),
      message("bot", [{ kind: "text", text: "Done" }]),
    ]);
    expect(text).toBe("# Ada\n\n---\n\n**Ada** · 2026-03-04 10:00\n\nDone\n");
  });

  it("keeps messages that are only a card, a choice, a page or a chart", () => {
    const text = transcript([
      message("bot", [
        {
          kind: "choice",
          question: "Which inbox?",
          options: [
            { id: "o_1", letter: "A", label: "Work" },
            { id: "o_2", letter: "B", label: "Home" },
          ],
          answerId: "o_2",
        },
      ]),
      message("bot", [{ kind: "card", lines: [{ k: "Label", v: "Receipts" }] }]),
      message("bot", [{ kind: "page", pageId: "p_1", version: 1, title: "Launch plan" }]),
      message("bot", [{ kind: "chart", name: "Weekly signups", spec: {}, data: [] }]),
    ]);
    expect(text).toContain("Which inbox?\n- A. Work\n- B. Home ✓");
    expect(text).toContain("- Label → Receipts");
    expect(text).toContain("\n\nLaunch plan");
    expect(text).toContain("\n\nWeekly signups");
  });

  it("leaves out tool activity and cards the chat hides", () => {
    const text = transcript([
      message("bot", [
        { kind: "progress", text: "Searching mail", activity: true },
        { kind: "text", text: "Found two" },
      ]),
      message("bot", [{ kind: "progress", text: "Reading thread 4", activity: true }]),
      message("bot", [{ kind: "import_setup", items: [], undone: true }]),
      message("bot", [{ kind: "choice", question: "Skip?", options: [], answerId: "_dismissed" }]),
    ]);
    expect(text).toBe("# Ada\n\n---\n\n**Ada** · 2026-03-04 10:00\n\nFound two\n");
  });

  it("shows an emoji reply under the message it reacts to, not as its own message", () => {
    const parent = message("bot", [{ kind: "text", text: "Sent the invoice" }]);
    const text = transcript([
      parent,
      message("user", [{ kind: "text", text: "👍" }], "2026-03-04T10:02:00.000Z", {
        replyToMessageId: parent.id,
      }),
      message("user", [{ kind: "text", text: "👍" }], "2026-03-04T10:03:00.000Z", {
        replyToMessageId: parent.id,
      }),
    ]);
    expect(text).toBe("# Ada\n\n---\n\n**Ada** · 2026-03-04 10:00\n\nSent the invoice\n\n👍 2\n");
  });

  it("leaves out the work a bot did for another bot, as the chat folds it", () => {
    const text = transcript([
      message(
        "bot",
        [
          {
            kind: "bot_message_received",
            fromBotId: "bot-2",
            fromBotName: "Lee",
            text: "Draft the brief",
            intent: "request",
          },
        ],
        "2026-03-04T10:00:00.000Z",
        { runId: "run-peer" },
      ),
      message("bot", [{ kind: "text", text: "Brief for Lee" }], "2026-03-04T10:01:00.000Z", {
        runId: "run-peer",
      }),
      message("bot", [{ kind: "text", text: "Done" }]),
    ]);
    expect(text).toBe("# Ada\n\n---\n\n**Ada** · 2026-03-04 10:00\n\nDone\n");
  });

  it("words each routine event by its change, not only its name", () => {
    const text = transcript([
      message("bot", [{ kind: "routine_event", change: "created", name: "Digest" }]),
      message("bot", [{ kind: "routine_event", change: "disabled", name: "Digest" }]),
      message("bot", [{ kind: "routine_event", change: "deleted", name: "Digest" }]),
    ]);
    expect(text).toContain('created routine "Digest"');
    expect(text).toContain('disabled routine "Digest"');
    expect(text).toContain('deleted routine "Digest"');
  });

  it("keeps your own Markdown-looking text literal, as the chat shows it, and the bot's as Markdown", () => {
    const text = transcript([
      message("user", [
        { kind: "text", text: "# not a heading\n*literal* and 2 * 3\n- dash\n1. one" },
      ]),
      message("bot", [{ kind: "text", text: "**Bold** reply" }]),
    ]);
    expect(text).toContain(
      "**You** · 2026-03-04 10:00\n\n\\# not a heading\\\n\\*literal\\* and 2 \\* 3\\\n\\- dash\\\n1\\. one",
    );
    expect(text).toContain("**Ada** · 2026-03-04 10:00\n\n**Bold** reply");
  });

  it("keeps a title or speaker on its own line, so it cannot add headings or speakers", () => {
    const text = chatTranscriptMarkdown({
      title: "Project\n\n## Another heading",
      messages: [message("user", [{ kind: "text", text: "Hi" }])],
      speaker: () => "Dana**\n\n**Lee",
      time: () => "10:00",
      routineEvent: (change, name) => `${change} ${name}`,
      askWords,
      cardStatus,
      cardLabels,
      memberName: (botId: string) => botId,
      attachment: "Attachment",
      isSetupComplete: () => false,
    });
    expect(text).toBe(
      "# Project \\#\\# Another heading\n\n---\n\n**Dana\\*\\* \\*\\*Lee** · 10:00\n\nHi\n",
    );
  });

  it("keeps labels, names and notes literal, as the chat shows them", () => {
    const text = transcript([
      message("bot", [{ kind: "page", pageId: "p_1", version: 1, title: "# Plan_v2" }]),
      message("bot", [{ kind: "card", lines: [{ k: "*Label*", v: "[x](y)" }] }]),
      message("system", [{ kind: "meta", text: "> quoted" }]),
    ]);
    expect(text).toContain("\n\n\\# Plan\\_v2");
    expect(text).toContain("- \\*Label\\* → \\[x\\](y)");
    expect(text).toContain("\n\n\\> quoted");
  });

  it("keeps an ask's detail and its options, with the chosen one marked", () => {
    const text = transcript([
      message("bot", [
        {
          kind: "ask",
          text: "Let Mail read your inbox?",
          detail: "Reads the last 7 days",
          detailFormat: "text",
          actions: [
            { id: "allow", label: "Allow once" },
            { id: "deny", label: "Deny" },
          ],
          status: "answered",
          answer: "deny",
        },
      ]),
    ]);
    // A text detail is prose, as the card draws it; only a code detail is fenced.
    expect(text).toContain(
      "Let Mail read your inbox?\n\nReads the last 7 days\n\n- Allow once\n- Deny \u2713",
    );
  });

  it("marks no option as chosen for an expired approval, and says it expired", () => {
    const text = transcript([
      message("bot", [
        {
          kind: "ask",
          text: "Let Mail send the reply?",
          actions: [
            { id: "allow", label: "Allow once" },
            { id: "deny", label: "Deny" },
          ],
          status: "answered",
          answer: "deny",
          expired: true,
        },
      ]),
    ]);
    expect(text).toContain("- Allow once\n- Deny\n\nExpired");
    expect(text).not.toContain("\u2713");
  });

  it("writes a receipt's rows once, without the page's own total row", () => {
    const text = transcript([
      message("bot", [
        {
          kind: "ask",
          text: "Pay for your order?",
          receipt: {
            button: "Pay $12.40",
            items: [
              { name: "Oat milk", amount: "$4.00" },
              { name: "Total", amount: "$12.40" },
            ],
            more: { count: 2, atLeast: false },
            amount: "$12.40",
            amountSource: "button",
            total: "$12.40",
          },
        },
      ]),
    ]);
    expect(text).toContain("- Oat milk: $4.00\n- 2 more\n- Total: $12.40\n- On the button: $12.40");
    expect(text.match(/Total: \$12\.40/g)).toHaveLength(1);
  });

  it("never writes a secret answer, and writes a typed answer unless it is its own message", () => {
    const secret = transcript([
      message("bot", [
        {
          kind: "ask",
          text: "Enter your bank PIN",
          input: "secret",
          status: "answered",
          answer: "4921",
        },
      ]),
    ]);
    expect(secret).toContain("Enter your bank PIN");
    expect(secret).not.toContain("4921");

    const reply = message("user", [{ kind: "text", text: "Tuesday" }], "2026-03-04T10:01:00.000Z");
    const separate = transcript([
      message(
        "bot",
        [
          {
            kind: "ask",
            text: "Which day?",
            status: "answered",
            answer: "Tuesday",
            answerMessageId: reply.id,
          },
        ],
        "2026-03-04T10:00:00.000Z",
      ),
      reply,
    ]);
    expect(separate.split("Tuesday")).toHaveLength(2);

    const typed = transcript([
      message("bot", [{ kind: "ask", text: "Which day?", status: "answered", answer: "Tuesday" }]),
    ]);
    expect(typed).toContain("Which day?\n\nAnswer: Tuesday");
  });

  it("writes a call as the chat's card shows it: the opening once answered, else its state and reason", () => {
    const call = (status: "answered" | "missed" | "declined" | "ringing", now = 0) =>
      chatTranscriptMarkdown({
        title: "Ada",
        messages: [
          message("bot", [
            {
              kind: "call_request",
              callId: "c_1",
              reason: "Your invoice is overdue",
              opening: "Hi Sam, *calling* about the invoice.",
              status,
              expiresAt: "2026-03-04T10:05:00.000Z",
            },
          ]),
        ],
        speaker: () => "Ada",
        time: () => "10:00",
        routineEvent: (change, name) => `${change} ${name}`,
        askWords,
        cardStatus,
        cardLabels,
        memberName: (botId: string) => botId,
        attachment: "Attachment",
        isSetupComplete: () => false,
        now,
      });
    const answered = call("answered");
    expect(answered).toContain("Hi Sam, \\*calling\\* about the invoice.");
    expect(answered).not.toContain("Your invoice is overdue");
    expect(answered).not.toContain("Missed call");
    const missed = call("missed");
    expect(missed).toContain("Missed call\n\nYour invoice is overdue");
    expect(missed).not.toContain("Hi Sam");
    expect(call("declined")).toContain("Missed call · You declined\n\nYour invoice is overdue");
    expect(call("ringing", Date.parse("2026-03-04T10:01:00.000Z"))).toContain(
      "Calling you…\n\nYour invoice is overdue",
    );
    // A ring past its end reads as missed, as the card turns it.
    expect(call("ringing", Date.parse("2026-03-04T10:06:00.000Z"))).toContain(
      "Missed call\n\nYour invoice is overdue",
    );
  });

  it("writes an answered card's state once its buttons are gone, as the card does", () => {
    const approval = {
      kind: "ask" as const,
      text: "Let Mail send the reply?",
      approvalEffectId: "eff_1",
      status: "answered" as const,
      actions: [
        { id: "allow", label: "Allow once" },
        { id: "always", label: "Always allow this tool" },
        { id: "deny", label: "Deny" },
      ],
    };
    const state = (block: ThreadMessage["blocks"][number]) => transcript([message("bot", [block])]);
    const allowed = state({ ...approval, answer: "allow" });
    expect(allowed).toContain("Let Mail send the reply?\n\nAllowed once");
    expect(allowed).not.toContain("- Deny");
    expect(state({ ...approval, answer: "always" })).toContain("Always allowed");
    expect(state({ ...approval, answer: "deny" })).toContain("Denied");
    expect(
      state({
        ...approval,
        answer: "allow",
        actions: [
          { id: "allow", label: "Allow in this space" },
          { id: "deny", label: "Deny" },
        ],
      }),
    ).toContain("Allowed in this space");
    // A plain ask answered with "approved" reads Sent; one with no answer reads Answered.
    expect(
      state({ kind: "ask", text: "Ready to send?", status: "answered", answer: "approved" }),
    ).toContain("Ready to send?\n\nSent");
    expect(state({ kind: "ask", text: "Ready?", status: "answered" })).toContain(
      "Ready?\n\nAnswered",
    );
    // A question keeps its options with the chosen one marked, and adds no state line.
    const question = state({
      kind: "ask",
      text: "Which day?",
      status: "answered",
      answer: "tue",
      actions: [
        { id: "mon", label: "Monday" },
        { id: "tue", label: "Tuesday" },
      ],
    });
    expect(question).toContain("- Monday\n- Tuesday \u2713");
    expect(question).not.toContain("Sent");
  });

  it("closes a fence that a line outside its list item or quote ended, as Markdown does", () => {
    const written = (text: string) =>
      transcript([
        message("bot", [{ kind: "text", text }]),
        message("bot", [{ kind: "text", text: "Done" }], "2026-03-04T10:01:00.000Z"),
      ]);
    // The bare fence at the margin ends the item, so it opens a new block that must be closed.
    expect(written("- ```js\n  const a = 1;\n```")).toContain(
      "- ```js\n  const a = 1;\n```\n```\n\n---\n\n",
    );
    expect(written("> ```\n> quoted\nplain\n```")).toContain("plain\n```\n```\n\n---\n\n");
    // Inside its container the same fence closes it, and nothing is added.
    expect(written("- ```js\n  const a = 1;\n  ```")).toContain("  ```\n\n---\n\n");
    expect(written("> ```\n> quoted\n> ```")).toContain("> ```\n\n---\n\n");
    // A fence on an item's own continuation line belongs to the item, so the margin fence ends it too.
    expect(written("1. Install\n   ```bash\n   npm i\n```")).toContain(
      "   npm i\n```\n```\n\n---\n\n",
    );
    // A line indented less than the fence but still inside the item keeps the fence open.
    expect(written("1. item\n\n    ```js\n    code\n   more\n    ```")).toContain(
      "   more\n    ```\n\n---\n\n",
    );
    // A fence at the margin ends the list, so a later shallow fence is not taken for an item's.
    expect(written("- a\n\n```\nx\n```\n\n  ```\n  code\n```")).toContain("  code\n```\n\n---\n\n");
    // So does a thematic break, without a blank line.
    expect(written("- a\n***\n  ```\n  code\n```")).toContain("  code\n```\n\n---\n\n");
    // An open fence in a quote is closed inside the quote.
    expect(written("> ```\n> quoted")).toContain("> quoted\n> ```\n\n---\n\n");
  });

  it("closes a code fence a bot left open, so it cannot run into the next message", () => {
    const text = transcript([
      message("bot", [{ kind: "text", text: "Here is the script:\n\n```js\nconst a = 1;" }]),
      message("bot", [{ kind: "text", text: "Done" }], "2026-03-04T10:01:00.000Z"),
    ]);
    expect(text).toContain("```js\nconst a = 1;\n```\n\n---\n\n");
  });

  it("closes an open fence in the column it was opened in, so it stays in its code block or list item", () => {
    const indented = transcript([
      message("bot", [{ kind: "text", text: "Indented:\n\n    ```js\n    const a = 1;" }]),
      message("bot", [{ kind: "text", text: "Done" }], "2026-03-04T10:01:00.000Z"),
    ]);
    expect(indented).toContain("    const a = 1;\n    ```\n\n---\n\n");
    expect(indented).not.toContain("\n```\n\n---");
    const listed = transcript([
      message("bot", [{ kind: "text", text: "- ```js\n  const a = 1;" }]),
      message("bot", [{ kind: "text", text: "Done" }], "2026-03-04T10:01:00.000Z"),
    ]);
    expect(listed).toContain("- ```js\n  const a = 1;\n  ```\n\n---\n\n");
  });

  it("leaves a fence nested in a list item as code, not escaped", () => {
    const text = transcript([
      message("bot", [
        { kind: "text", text: "1. Run:\n\n    ```html\n    <div>hi</div>\n    ```" },
      ]),
    ]);
    expect(text).toContain("    <div>hi</div>\n    ```");
    expect(text).not.toContain("\\<div>");
  });

  it("keeps a typed line's leading spaces and tabs, without making it a code block", () => {
    const text = transcript([
      message("user", [{ kind: "text", text: "    const a = 1;\n\tif (a) {" }]),
    ]);
    expect(text).toContain(
      "\u00a0\u00a0\u00a0\u00a0const a = 1;\\\n\u00a0\u00a0\u00a0\u00a0if (a) {",
    );
  });

  it("writes a helper's name with its state and task, then its result or progress, and no result for a stopped helper", () => {
    const text = transcript([
      message("bot", [
        {
          kind: "subagent",
          agentId: "h_1",
          name: "Researcher",
          task: "Find the invoice",
          status: "completed",
          result: "```txt\nInvoice 42",
        },
      ]),
      message("bot", [
        {
          kind: "subagent",
          agentId: "h_2",
          name: "Reader",
          task: "Read the page",
          status: "running",
          progress: "Reading 3 pages",
        },
      ]),
      message("bot", [
        {
          kind: "subagent",
          agentId: "h_3",
          name: "Mailer",
          task: "Send it",
          status: "failed",
          result: "stopped",
        },
      ]),
    ]);
    expect(text).toContain(
      "**Researcher** · Completed\n\nFind the invoice\n\n```txt\nInvoice 42\n```",
    );
    expect(text).toContain("**Reader** · Running\n\nRead the page\n\nReading 3 pages");
    expect(text).toContain("**Mailer** · Stopped\n\nSend it");
    expect(text).not.toContain("stopped");
  });

  it("writes an outgoing draft as the fields its card shows, not its question", () => {
    const text = transcript([
      message("bot", [
        {
          kind: "ask",
          text: "Send this email?",
          outgoingDraft: {
            source: "Mail",
            values: {
              kind: "email",
              to: "dana@example.com",
              subject: "Invoice",
              body: "Hi *Dana*,\n# not a heading",
            },
            keys: { to: "to", body: "body", subject: "subject" },
          },
        },
      ]),
    ]);
    expect(text).toContain(
      "To: dana@example.com\n\nSubject: Invoice\n\nHi \\*Dana\\*,\\\n\\# not a heading",
    );
    expect(text).not.toContain("Send this email?");
  });

  it("writes an instructions update's question in the reader's words, as the card shows it", () => {
    const text = chatTranscriptMarkdown({
      title: "Ada",
      messages: [
        message("bot", [
          {
            kind: "ask",
            text: "Update instructions?",
            instructionUpdate: {
              botId: "bot-1",
              before: "Be brief",
              after: "Be kind",
              reason: "Asked",
            },
          },
        ]),
      ],
      speaker: () => "Ada",
      time: () => "10:00",
      routineEvent: (change, name) => `${change} ${name}`,
      askWords: { ...askWords, updateInstructions: "Atualizar instruções?" },
      cardStatus,
      cardLabels,
      memberName: (botId: string) => botId,
      attachment: "Attachment",
      isSetupComplete: () => false,
    });
    expect(text).toContain("Atualizar instruções?");
    expect(text).not.toContain("Update instructions?");
  });

  it("writes a settled instructions or settings change as the card shows it, not as a question", () => {
    const text = transcript([
      message("bot", [
        {
          kind: "ask",
          text: "Update instructions?",
          instructionUpdate: {
            botId: "bot-1",
            before: "Be brief",
            after: "Be kind",
            reason: "Asked",
            undoVersionId: "v_1",
          },
        },
        {
          kind: "ask",
          text: "Change settings?",
          settingsUpdate: { botId: "bot-1", before: {}, after: { autoSpeak: true } },
        },
      ]),
    ]);
    expect(text).toContain("Instructions updated\n\nSettings updated");
    expect(text).not.toContain("Update instructions?");
    expect(text).not.toContain("Change settings?");
  });

  it("writes a tool's question under its source", () => {
    const text = transcript([
      message("bot", [
        {
          kind: "tool_question",
          question: { source: "Calendar", message: "Which day works?", fields: [] },
          status: "pending",
          expiresAt: "2026-03-05T10:00:00.000Z",
          publicKey: "k",
        },
      ]),
    ]);
    expect(text).toContain("Calendar\n\nWhich day works?");
  });

  it("escapes a bot's raw HTML outside code, so an open tag cannot hide what follows", () => {
    const text = transcript([
      message("bot", [
        { kind: "text", text: "<!-- note\nUse `<b>` and <https://example.com>\n```\n<pre>\n```" },
      ]),
      message("user", [{ kind: "text", text: "Thanks" }], "2026-03-04T10:01:00.000Z"),
    ]);
    expect(text).toContain("\\<!-- note");
    expect(text).toContain("Use `<b>` and <https://example.com>");
    expect(text).toContain("```\n<pre>\n```");
  });

  it("escapes a tag after an escaped backtick, which opens no code span", () => {
    const text = transcript([
      message("bot", [{ kind: "text", text: "Type \\` then <span hidden> x`" }]),
    ]);
    expect(text).toContain("\\<span hidden>");
  });

  it("escapes a < that follows backslashes so the escape is not cancelled", () => {
    const text = transcript([message("bot", [{ kind: "text", text: "C:\\\\<b> and \\<i>" }])]);
    expect(text).toContain("C:\\\\\\<b> and \\<i>");
  });

  it("writes a secret ask's detail only when its card shows it, a one-time code", () => {
    const secretAsk = {
      kind: "ask" as const,
      text: "Enter the code",
      input: "secret" as const,
      detail: "Hidden detail text",
      status: "pending" as const,
    };
    expect(transcript([message("bot", [secretAsk])])).not.toContain("Hidden detail text");
    expect(
      transcript([
        message("bot", [{ ...secretAsk, oneTimeCode: { origin: "https://example.com" } }]),
      ]),
    ).toContain("Hidden detail text");
    // An approval is drawn by the prompt card, which shows its detail.
    expect(transcript([message("bot", [{ ...secretAsk, approvalEffectId: "eff_1" }])])).toContain(
      "Hidden detail text",
    );
  });

  it("writes a text detail as prose, as its card shows it, and a code detail as code", () => {
    const detail = "Total *due*";
    const prose = transcript([
      message("bot", [{ kind: "ask", text: "Pay?", detail, detailFormat: "text" }]),
    ]);
    expect(prose).toContain("Total \\*due\\*");
    const code = transcript([message("bot", [{ kind: "ask", text: "Pay?", detail }])]);
    expect(code).toContain("```\nTotal *due*\n```");
  });

  it("never writes an answer typed into a secret ask, even one tied to an approval", () => {
    const text = transcript([
      message("bot", [
        {
          kind: "ask",
          text: "Enter the code",
          input: "secret",
          approvalEffectId: "eff_1",
          status: "answered",
          answer: "991122",
        },
      ]),
    ]);
    expect(text).toContain("Enter the code");
    expect(text).not.toContain("991122");
  });

  it("writes a payment's note under its amounts, naming the button as the card does", () => {
    const receipt = {
      items: [{ name: "Oat milk", amount: "$4.00" }],
      amount: "$4.00",
      amountSource: "page" as const,
    };
    expect(transcript([message("bot", [{ kind: "ask", text: "Pay?", receipt }])])).toContain(
      "- Oat milk: $4.00\n- Total: $4.00\n\nRead from the page, not checked",
    );
    expect(
      transcript([
        message("bot", [
          {
            kind: "ask",
            text: "Pay?",
            receipt: { ...receipt, button: "Pay $4.00", amountSource: "button" as const },
          },
        ]),
      ]),
    ).toContain("- On the button: $4.00\n\nButton “Pay $4.00”. Read from the page, not checked");
  });

  it("writes a protected answer's outcome as its card words it, never its value", () => {
    const pin = {
      kind: "ask" as const,
      text: "Enter your PIN",
      input: "secret" as const,
      status: "answered" as const,
      answer: "4921",
    };
    expect(transcript([message("bot", [pin])])).toContain("Enter your PIN\n\nSaved");
    expect(transcript([message("bot", [{ ...pin, remembered: false as const }])])).toContain(
      "Enter your PIN\n\nSent",
    );
    expect(
      transcript([message("bot", [{ ...pin, oneTimeCode: { origin: "https://example.com" } }])]),
    ).toContain("Enter your PIN\n\nOnly enter a code example.com sent you.\n\nSent");
    expect(transcript([message("bot", [{ ...pin, dismissed: true as const }])])).toContain(
      "Enter your PIN\n\nDismissed",
    );
    const pending = transcript([message("bot", [{ ...pin, status: "pending" as const }])]);
    expect(pending).not.toContain("Saved");
    expect(pending).not.toContain("4921");
  });

  it("writes an archived or deleted bot's status beside its name, and a live bot's name alone", () => {
    expect(
      transcript([
        message("bot", [
          { kind: "child_bot", botId: "b_2", name: "Lee", status: "archived" },
          { kind: "child_bot", botId: "b_3", name: "Max", status: "deleted" },
          { kind: "child_bot", botId: "b_4", name: "Ada", status: "created" },
        ]),
      ]),
    ).toContain("Lee · archived\n\nMax · deleted\n\nAda");
  });

  it("writes a draft's outcome once answered, and a protected request's destination as its card shows it", () => {
    const draft = {
      source: "Mail",
      values: { kind: "email" as const, to: "dana@example.com", subject: "Invoice", body: "Hi" },
      keys: { to: "to", body: "body", subject: "subject" },
    };
    expect(
      transcript([message("bot", [{ kind: "ask", text: "Send?", outgoingDraft: draft }])]),
    ).not.toContain("Discarded");
    expect(
      transcript([
        message("bot", [
          { kind: "ask", text: "Send?", outgoingDraft: draft, status: "answered", answer: "deny" },
        ]),
      ]),
    ).toContain("Subject: Invoice\n\nHi\n\nDiscarded");
    const command = {
      kind: "ask" as const,
      text: "Enter the token",
      input: "secret" as const,
      status: "pending" as const,
      credential: {
        name: "github_token",
        origin: "https://api.github.com",
        auth: { type: "command" as const },
      },
    };
    expect(transcript([message("bot", [command])])).toContain("Command variable $");
    expect(
      transcript([
        message("bot", [
          {
            ...command,
            credential: undefined,
            oneTimeCode: { origin: "https://shop.example.com/x" },
          },
        ]),
      ]),
    ).toContain("Only enter a code shop.example.com sent you.");
    expect(
      transcript([
        message("bot", [
          {
            ...command,
            credential: {
              name: "api_token",
              origin: "https://api.example.com",
              auth: { type: "bearer" as const },
            },
          },
        ]),
      ]),
    ).toContain("https://api.example.com");
  });

  it("names both bots of a handoff, as the chat row does", () => {
    const text = chatTranscriptMarkdown({
      title: "Crew",
      messages: [
        message("bot", [
          { kind: "handoff", fromBotId: "b_ada", toBotId: "b_lee", text: "Take the invoice" },
        ]),
      ],
      speaker: () => "Ada",
      time: () => "10:00",
      routineEvent: (change, name) => `${change} ${name}`,
      askWords,
      cardStatus,
      cardLabels,
      memberName: (botId) => (botId === "b_lee" ? "Lee" : "Ada"),
      attachment: "Attachment",
      isSetupComplete: () => false,
    });
    expect(text).toContain("\u21aa Lee \u2190 Ada\n\nTake the invoice");
  });

  it("leaves out a login's owner-only notices", () => {
    const login = {
      kind: "ask" as const,
      text: "Sign in to the shop",
      input: "secret" as const,
      sharedBrowser: true as const,
      credential: {
        name: "shop_login",
        origin: "https://shop.example",
        auth: { type: "login" as const },
      },
      replaces: { id: "c_1", origin: "https://shop.example" },
    };
    for (const block of [login, { ...login, status: "answered" as const, answer: "hunter2" }]) {
      const text = transcript([message("bot", [block])]);
      expect(text).toContain("Sign in to the shop");
      expect(text).not.toContain("signed in for everyone");
      expect(text).not.toContain("Replaces the login");
      expect(text).not.toContain("hunter2");
    }
  });

  it("writes a call as its card's label and length, then its title", () => {
    expect(
      transcript([
        message("bot", [{ kind: "voice_call", title: "", farewell: "Bye", durationSeconds: 185 }]),
      ]),
    ).toContain("**Ada** · 2026-03-04 10:00\n\nPhone call · 3:05");
    // A call with neither a title nor a recorded length still shows as a call.
    expect(transcript([message("bot", [{ kind: "voice_call", title: "", farewell: "Bye" }])])).toBe(
      "# Ada\n\n---\n\n**Ada** · 2026-03-04 10:00\n\nPhone call\n",
    );
    expect(
      transcript([
        message("bot", [
          { kind: "voice_call", title: "Renewal", farewell: "Bye", durationSeconds: 60 },
        ]),
      ]),
    ).toContain("Phone call · 1:00\n\nRenewal");
  });

  it("labels the end of a call the bot placed as its card does", () => {
    const text = transcript([
      message("bot", [
        {
          kind: "call_request",
          callId: "c_1",
          reason: "Your invoice is overdue",
          opening: "Hi Sam",
          status: "answered",
          expiresAt: "2026-03-04T10:05:00.000Z",
        },
      ]),
      message("bot", [
        { kind: "voice_call", callId: "c_1", title: "", farewell: "", durationSeconds: 185 },
      ]),
    ]);
    expect(text).toContain("Incoming call · 3:05");
    expect(text).not.toContain("Phone call");
  });

  it("takes a bot-placed call's length from its request when the bot hung up", () => {
    const text = transcript([
      message("bot", [
        {
          kind: "call_request",
          callId: "c_1",
          reason: "Your invoice is overdue",
          opening: "Hi Sam",
          status: "answered",
          expiresAt: "2026-03-04T10:05:00.000Z",
          durationSeconds: 185,
        },
      ]),
      message("bot", [{ kind: "voice_call", callId: "c_1", title: "", farewell: "Bye" }]),
    ]);
    expect(text).toContain("Incoming call · 3:05");
  });

  it("writes a finished checklist as its completion, and an open one as its items", () => {
    const checklist = {
      kind: "import_setup" as const,
      items: [{ kind: "routine" as const, routineId: "r_1", name: "Morning digest" }],
    };
    const render = (isSetupComplete: (block: unknown) => boolean) =>
      chatTranscriptMarkdown({
        title: "Ada",
        messages: [message("bot", [checklist])],
        speaker: () => "Ada",
        time: () => "10:00",
        routineEvent: (change, name) => `${change} ${name}`,
        askWords,
        cardStatus,
        cardLabels,
        memberName: (botId: string) => botId,
        attachment: "Attachment",
        isSetupComplete: (block) => isSetupComplete(block),
      });
    expect(render((block) => block === checklist)).toContain("Setup complete");
    expect(render((block) => block === checklist)).not.toContain("Morning digest");
    expect(render(() => false)).toContain("- Morning digest");
  });

  it("writes each card's state and context as the card shows them", () => {
    const one = (block: ThreadMessage["blocks"][number]) =>
      transcript([message("bot", [block])])
        .split("10:00\n\n")[1]
        ?.trimEnd();
    const agent = { kind: "cloud_agent" as const, agentId: "a_1", title: "Fix login", url: "" };
    expect(one({ ...agent, status: "running", branch: "fix/login" })).toBe(
      "Fix login · running\n\nfix/login",
    );
    expect(
      one({ ...agent, status: "finished", branch: "fix/login", prUrl: "https://example.com/pr/1" }),
    ).toBe("Fix login · finished\n\nPull request");
    expect(one({ ...agent, status: "failed" })).toBe("Fix login · failed");
    const app = { kind: "app_connect" as const, provider: "p", name: "Mail", logo: null };
    expect(one({ ...app, description: "Read and send mail", status: "pending" })).toBe(
      "Mail\n\nRead and send mail",
    );
    expect(one({ ...app, description: "Read and send mail", status: "connected" })).toBe(
      "Mail\n\nRead and send mail\n\nConnected",
    );
    const server = {
      kind: "mcp_approval" as const,
      name: "Docs",
      serverId: "s_1",
      needsOAuth: false,
    };
    expect(
      one({ ...server, transport: "sse", endpoint: "https://docs.example.com", status: "pending" }),
    ).toBe("Connect MCP server “Docs”\n\nhttps://docs.example.com");
    expect(one({ ...server, transport: "stdio", endpoint: null, status: "connected" })).toBe(
      "Connect MCP server “Docs”\n\nstdio (stdio)\n\nConnected",
    );
    expect(one({ ...server, transport: "stdio", endpoint: null, status: "dismissed" })).toContain(
      "\n\nDismissed",
    );
    const question = {
      kind: "tool_question" as const,
      question: { source: "Calendar", message: "Which day?", fields: [] },
      expiresAt: "2026-03-05T10:00:00.000Z",
      publicKey: "k",
    };
    expect(one({ ...question, status: "accepted" })).toBe("Calendar\n\nWhich day?\n\nSent");
    expect(one({ ...question, status: "declined" })).toContain("Which day?\n\nDeclined");
    expect(one({ ...question, status: "expired" })).toContain("Which day?\n\nExpired");
    expect(one({ kind: "computer", state: "Done", text: "Sign in to the bank" })).toBe(
      "Computer · Done\n\nSign in to the bank",
    );
    expect(one({ kind: "computer", state: "Needs you", text: "Solve the *captcha*" })).toBe(
      "Computer · Needs you\n\nSolve the *captcha*",
    );
    const draft = one({
      kind: "skill_draft",
      skillId: "sk_1",
      name: "Weekly *report*",
      goal: "Summarize the week",
      playbook: {
        whenToUse: "Fridays",
        inputs: ["Inbox", "Calendar"],
        steps: ["Read mail", "Write summary"],
        howToCheck: "",
        whatToReturn: "A short note",
        approvalBoundaries: "",
        failureHandling: "Say what failed",
      },
      status: "saved",
    });
    expect(draft).toBe(
      [
        "**Draft skill**",
        "Summarize the week",
        "Name: Weekly \\*report\\*",
        "When to use:\\\nFridays",
        "Inputs:\\\nInbox\\\nCalendar",
        "Steps:\\\nRead mail\\\nWrite summary",
        "What to return:\\\nA short note",
        "Failure handling:\\\nSay what failed",
        "Saved",
      ].join("\n\n"),
    );
  });

  it("keeps a bot's indented code as typed, with no backslash before its tags", () => {
    const text = transcript([
      message("bot", [{ kind: "text", text: "Markup:\n\n    <div>\n\n    </div>\nThen <b>bold" }]),
    ]);
    expect(text).toContain("Markup:\n\n    <div>\n\n    </div>\nThen \\<b>bold");
    // An indented line in a list item continues the item's text, so its tag is escaped.
    const listed = transcript([
      message("bot", [{ kind: "text", text: "1. Step\n\n    Use <b>bold\n\nAfter\n\n    <i>" }]),
    ]);
    expect(listed).toContain("    Use \\<b>bold");
    expect(listed).toContain("After\n\n    <i>");
    // An item's later paragraph keeps the list open, so a deeper line is still the item's text.
    for (const text of [
      "1. Step\n\n   More text\n\n    Use <b>bold",
      "- a\n\n  b\n\n    <b>bold",
    ]) {
      expect(transcript([message("bot", [{ kind: "text", text }])])).toContain("\\<b>bold");
    }
    // An indented line that continues a paragraph is text, not code, so its tag is escaped.
    expect(transcript([message("bot", [{ kind: "text", text: "Text\n    <b>x" }])])).toContain(
      "Text\n    \\<b>x",
    );
  });

  it("is just the title for an empty chat", () => {
    expect(transcript([])).toBe("# Ada\n");
  });
});
