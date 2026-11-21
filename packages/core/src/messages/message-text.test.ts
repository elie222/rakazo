import type { ThreadMessage } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  canShareReply,
  copyableMessagesText,
  copyableMessageText,
  selectableMessageText,
  sharedReplyText,
} from "./message-text.js";

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

  it("leaves out a block kind it does not know, as an older client does with a newer server's page", () => {
    // Clients read blocks without validating them, so a newer kind reaches this code as is.
    const page = { kind: "page", pageId: "page-1", version: 1, title: "Plan" };
    const blocks = [{ kind: "text", text: "Here it is" }, page] as ThreadMessage["blocks"];
    expect(copyableMessageText(message(blocks))).toBe("Here it is");
  });

  it("includes channel messages with their chat attribution", () => {
    expect(
      copyableMessageText(
        message([
          {
            kind: "channel_message",
            provider: "sendblue",
            transport: "RCS",
            channelId: "ch-1",
            fromAddress: "+15551234567",
            fromLabel: "Alice",
            text: "dinner at 7?",
            hop: 0,
          },
        ]),
      ),
    ).toBe("Alice (RCS): dinner at 7?");
  });

  it("falls back to the provider label for unknown transport values", () => {
    expect(
      copyableMessageText(
        message([
          {
            kind: "channel_message",
            provider: "sendblue",
            transport: "email",
            channelId: "ch-1",
            fromAddress: "+15551234567",
            fromLabel: "Alice",
            text: "hello",
          },
        ]),
      ),
    ).toBe("Alice (iMessage): hello");
  });

  it("leaves out card chrome between text and channel messages", () => {
    expect(
      copyableMessageText(
        message([
          { kind: "text", text: "Hello" },
          {
            kind: "channel_message",
            provider: "sendblue",
            transport: "SMS",
            channelId: "ch-1",
            fromAddress: "+15551234567",
            fromLabel: "Sender",
            text: "Reply",
          },
          { kind: "card", lines: [] },
        ]),
      ),
    ).toBe("Hello\nSender (SMS): Reply");
  });

  it("keeps leading whitespace for selection while copying trims it", () => {
    const indented = message([{ kind: "text", text: "    indented\nnext  " }]);
    expect(selectableMessageText(indented)).toBe("    indented\nnext  ");
    expect(copyableMessageText(indented)).toBe("indented\nnext");
  });
});

describe("copyableMessagesText", () => {
  it("joins messages in the order given with a blank line between them", () => {
    expect(
      copyableMessagesText([
        message([{ kind: "text", text: "first" }]),
        message([{ kind: "text", text: "  second\nline  " }]),
      ]),
    ).toBe("first\n\nsecond\nline");
  });

  it("skips a message with nothing to copy instead of leaving a gap", () => {
    const card = message([{ kind: "card", lines: [] }]);
    expect(
      copyableMessagesText([
        message([{ kind: "text", text: "a" }]),
        card,
        message([{ kind: "text", text: "   " }]),
        message([{ kind: "text", text: "b" }]),
      ]),
    ).toBe("a\n\nb");
    expect(copyableMessagesText([card])).toBe("");
    expect(copyableMessagesText([])).toBe("");
  });
});

describe("sharedReplyText", () => {
  const canary = "CANARY-7f3a";
  const reply = message([
    { kind: "text", text: "  The answer is 42.  " },
    { kind: "progress", text: canary },
    { kind: "steps", steps: [{ label: "Searched", count: 1, note: canary }] },
    { kind: "card", lines: [{ k: "key", v: canary }] },
    { kind: "meta", text: canary },
    { kind: "ask", text: canary },
    { kind: "computer", state: "ready", text: canary },
    { kind: "file", artifactId: "a_1", mimeType: "text/plain", name: canary, size: 1 },
    { kind: "image", artifactId: "a_2", mimeType: "image/png", name: canary },
    { kind: "text", text: "Ask secret-token." },
  ]);

  it("keeps only the reply's text blocks, never hidden fields", () => {
    const text = sharedReplyText(reply, (value) => value);
    expect(text).toBe("The answer is 42.\n\nAsk secret-token.");
    expect(text).not.toContain(canary);
  });

  it("applies the redaction it is given to the whole text", () => {
    const redact = vi.fn((value: string) => value.replace("secret-token", "[Redacted]"));
    expect(sharedReplyText(reply, redact)).toBe("The answer is 42.\n\nAsk [Redacted].");
    expect(redact).toHaveBeenCalledOnce();
  });

  it("reads stored rows whose text is not a string", () => {
    const stored = message([{ kind: "text", text: 7 } as never, { kind: "text", text: "kept" }]);
    expect(sharedReplyText(stored, (value) => value)).toBe("kept");
  });
});

describe("canShareReply", () => {
  const text = { kind: "text", text: "Hello" } as const;

  it("shares a saved bot reply with text", () => {
    expect(canShareReply(message([text]))).toBe(true);
  });

  it("never shares people's messages, unsaved rows, deliveries, bot-to-bot receipts or empty replies", () => {
    expect(canShareReply({ ...message([text]), role: "user" })).toBe(false);
    expect(canShareReply({ ...message([text]), id: "progress:run_1" })).toBe(false);
    expect(canShareReply(message([text, { kind: "delivery" }]))).toBe(false);
    expect(
      canShareReply(
        message([
          text,
          { kind: "bot_message_sent", toBotId: "b_2", toBotName: "Peer", text: "Hi" },
        ]),
      ),
    ).toBe(false);
    expect(canShareReply(message([{ kind: "text", text: "   " }]))).toBe(false);
    expect(canShareReply(message([{ kind: "progress", text: "working" }]))).toBe(false);
  });
});
