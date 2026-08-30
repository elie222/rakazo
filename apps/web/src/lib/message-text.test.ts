import type { ThreadMessage } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { copyableMessageText } from "./message-text.js";

function message(blocks: ThreadMessage["blocks"]): ThreadMessage {
  return { id: "m_1", threadId: "t_1", seq: 1, role: "bot", blocks, createdAt: "2026-08-29" };
}

describe("copyableMessageText", () => {
  it("joins text, progress, and ask blocks without chrome", () => {
    expect(
      copyableMessageText(
        message([
          { kind: "text", text: "first" },
          { kind: "progress", text: "working" },
          { kind: "ask", text: "question?" },
        ]),
      ),
    ).toBe("first\nworking\nquestion?");
  });

  it("includes phone channel messages with their iMessage attribution", () => {
    expect(
      copyableMessageText(
        message([
          {
            kind: "phone_channel_message",
            channelId: "ch-1",
            fromNumber: "+15551234567",
            fromLabel: "Alice",
            text: "dinner at 7?",
            hop: 0,
          },
        ]),
      ),
    ).toBe("iMessage · Alice: dinner at 7?");
  });
});
