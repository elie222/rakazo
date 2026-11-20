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

const transcript = (messages: ThreadMessage[]) =>
  chatTranscriptMarkdown({
    title: "Ada",
    messages,
    speaker: (item) => (item.role === "user" ? "You" : "Ada"),
    time: (createdAt) => createdAt.slice(0, 16).replace("T", " "),
    routineEvent: (change, name) => `${change} routine "${name}"`,
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
    expect(text).toContain("Here you go\nAttachment: chart.png\nAttachment: q1.csv");
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

  it("is just the title for an empty chat", () => {
    expect(transcript([])).toBe("# Ada\n");
  });
});
