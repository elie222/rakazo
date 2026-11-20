import type { ThreadMessage } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { chatTranscriptMarkdown } from "./chat-transcript.js";

let seq = 0;
function message(
  role: ThreadMessage["role"],
  blocks: ThreadMessage["blocks"],
  createdAt = "2026-03-04T10:00:00.000Z",
): ThreadMessage {
  seq += 1;
  return { id: `m_${seq}`, threadId: "t_1", seq, role, blocks, createdAt };
}

const transcript = (messages: ThreadMessage[]) =>
  chatTranscriptMarkdown({
    title: "Ada",
    messages,
    speaker: (item) => (item.role === "user" ? "You" : "Ada"),
    time: (createdAt) => createdAt.slice(0, 16).replace("T", " "),
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

  it("is just the title for an empty chat", () => {
    expect(transcript([])).toBe("# Ada\n");
  });
});
