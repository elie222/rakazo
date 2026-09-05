import type { ThreadMessage } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { hasPeerConversation, peerConversations, peerMessagesFrom } from "./peer-messages.js";

function message(
  id: string,
  createdAt: string,
  blocks: ThreadMessage["blocks"],
  options: Pick<ThreadMessage, "role" | "runId"> = { role: "bot" },
): ThreadMessage {
  return { id, threadId: "t_1", seq: 1, blocks, createdAt, ...options };
}

const sentToAnalyst = message("m_1", "2026-08-25T10:00:00.000Z", [
  { kind: "bot_message_sent", toBotId: "b_2", toBotName: "Analyst", text: "chart q3" },
]);
const replyFromAnalyst = message("m_2", "2026-08-25T10:01:00.000Z", [
  { kind: "bot_message_received", fromBotId: "b_2", fromBotName: "Analyst", text: "done" },
]);
const plainText = message("m_3", "2026-08-25T10:02:00.000Z", [{ kind: "text", text: "hello" }]);

describe("peer conversations", () => {
  const messages = [sentToAnalyst, replyFromAnalyst, plainText];

  it("reads both directions out of the thread", () => {
    expect(peerMessagesFrom(messages)).toEqual([
      expect.objectContaining({ direction: "sent", peerBotName: "Analyst", text: "chart q3" }),
      expect.objectContaining({ direction: "received", peerBotName: "Analyst", text: "done" }),
    ]);
  });

  it("groups an exchange with one peer into a single conversation", () => {
    const conversations = peerConversations(messages);
    expect(conversations).toHaveLength(1);
    expect(conversations[0]?.peerBotName).toBe("Analyst");
    expect(conversations[0]?.messages).toHaveLength(2);
    expect(conversations[0]?.lastText).toBe("done");
  });

  it("includes the generated reply from a bot-message run", () => {
    const received = message(
      "m_4",
      "2026-08-25T10:03:00.000Z",
      [
        {
          kind: "bot_message_received",
          fromBotId: "b_2",
          fromBotName: "Analyst",
          text: "status?",
        },
      ],
      { role: "user", runId: "run-peer" },
    );
    const generatedReply = message(
      "m_5",
      "2026-08-25T10:04:00.000Z",
      [
        { kind: "steps", steps: [{ label: "Research", count: 1 }], durationMs: 100 },
        { kind: "text", text: "The report is ready." },
      ],
      { role: "bot", runId: "run-peer" },
    );

    expect(peerMessagesFrom([received, generatedReply])).toEqual([
      expect.objectContaining({ direction: "received", text: "status?" }),
      expect.objectContaining({ direction: "sent", text: "The report is ready." }),
    ]);
  });

  it("does not duplicate a generated reply that was explicitly sent to the same peer", () => {
    const received = message(
      "m_4",
      "2026-08-25T10:03:00.000Z",
      [
        {
          kind: "bot_message_received",
          fromBotId: "b_2",
          fromBotName: "Analyst",
          text: "status?",
        },
      ],
      { role: "user", runId: "run-peer" },
    );
    const generatedReply = message(
      "m_5",
      "2026-08-25T10:04:00.000Z",
      [{ kind: "text", text: "NO-SHIP" }],
      { role: "bot", runId: "run-peer" },
    );
    const sentReceipt = message(
      "m_6",
      "2026-08-25T10:04:00.018Z",
      [{ kind: "bot_message_sent", toBotId: "b_2", toBotName: "Analyst", text: "NO-SHIP" }],
      { role: "bot", runId: "run-peer" },
    );

    const peerMessages = peerMessagesFrom([received, generatedReply, sentReceipt]);

    expect(peerMessages).toHaveLength(2);
    expect(peerMessages.filter((entry) => entry.text === "NO-SHIP")).toEqual([
      expect.objectContaining({ messageId: "m_6", direction: "sent" }),
    ]);
  });

  it("does not attribute ordinary bot text to a peer conversation", () => {
    const generatedReply = message(
      "m_5",
      "2026-08-25T10:04:00.000Z",
      [{ kind: "text", text: "Visible human reply" }],
      { role: "bot", runId: "run-human" },
    );

    expect(peerMessagesFrom([generatedReply])).toEqual([]);
  });

  it("orders conversations by most recent activity", () => {
    const older = message("m_0", "2026-08-24T09:00:00.000Z", [
      { kind: "bot_message_sent", toBotId: "b_3", toBotName: "Scout", text: "look into it" },
    ]);
    expect(peerConversations([older, ...messages]).map((c) => c.peerBotName)).toEqual([
      "Analyst",
      "Scout",
    ]);
  });

  it("finds nothing in a thread with no peer traffic", () => {
    expect(peerConversations([plainText])).toEqual([]);
  });
});

describe("hasPeerConversation", () => {
  it("is true when the selected peer appears in loaded pages", () => {
    expect(hasPeerConversation([sentToAnalyst, replyFromAnalyst, plainText], "b_2")).toBe(true);
  });

  it("is false when loaded pages only contain other peers", () => {
    const other = message("m_other", "2026-08-25T09:00:00.000Z", [
      { kind: "bot_message_sent", toBotId: "b_9", toBotName: "Other", text: "hi" },
    ]);
    expect(hasPeerConversation([other], "b_2")).toBe(false);
  });
});
