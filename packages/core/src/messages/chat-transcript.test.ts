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
};

const transcript = (messages: ThreadMessage[]) =>
  chatTranscriptMarkdown({
    title: "Ada",
    messages,
    speaker: (item) => (item.role === "user" ? "You" : "Ada"),
    time: (createdAt) => createdAt.slice(0, 16).replace("T", " "),
    routineEvent: (change, name) => `${change} routine "${name}"`,
    askWords,
    attachment: "Attachment",
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
      attachment: "Attachment",
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
    expect(text).toContain("Let Mail read your inbox?\n\n```\nReads the last 7 days\n```");
    expect(text).toContain("- Allow once\n- Deny \u2713");
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

  it("writes a call as the chat's card shows it: the opening once answered, the reason otherwise", () => {
    const call = (status: "answered" | "missed") =>
      transcript([
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
      ]);
    const answered = call("answered");
    expect(answered).toContain("Hi Sam, \\*calling\\* about the invoice.");
    expect(answered).not.toContain("Your invoice is overdue");
    const missed = call("missed");
    expect(missed).toContain("Your invoice is overdue");
    expect(missed).not.toContain("Hi Sam");
  });

  it("closes a code fence a bot left open, so it cannot run into the next message", () => {
    const text = transcript([
      message("bot", [{ kind: "text", text: "Here is the script:\n\n```js\nconst a = 1;" }]),
      message("bot", [{ kind: "text", text: "Done" }], "2026-03-04T10:01:00.000Z"),
    ]);
    expect(text).toContain("```js\nconst a = 1;\n```\n\n---\n\n");
  });

  it("keeps a typed line's leading spaces and tabs, without making it a code block", () => {
    const text = transcript([
      message("user", [{ kind: "text", text: "    const a = 1;\n\tif (a) {" }]),
    ]);
    expect(text).toContain(
      "\u00a0\u00a0\u00a0\u00a0const a = 1;\\\n\u00a0\u00a0\u00a0\u00a0if (a) {",
    );
  });

  it("writes a helper's result or progress under its name, and nothing for a stopped helper", () => {
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
    expect(text).toContain("**Researcher**\n\n```txt\nInvoice 42\n```");
    expect(text).toContain("**Reader**\n\nReading 3 pages");
    expect(text).toContain("**Mailer**");
    expect(text).not.toContain("Find the invoice");
    expect(text).not.toContain("Read the page");
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
      attachment: "Attachment",
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

  it("is just the title for an empty chat", () => {
    expect(transcript([])).toBe("# Ada\n");
  });
});
