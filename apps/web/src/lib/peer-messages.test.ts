import type { ThreadMessage } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { isPeerOnlyMessage, peerConversations, peerMessagesFrom } from "./peer-messages.js";

function message(id: string, createdAt: string, blocks: ThreadMessage["blocks"]): ThreadMessage {
  return { id, threadId: "t_1", seq: 1, role: "bot", blocks, createdAt };
}

const sentToAnalyst = message("m_1", "2026-08-25T10:00:00.000Z", [
  { kind: "bot_message_sent", toBotId: "b_2", toBotName: "Analyst", text: "chart q3" },
]);
const replyFromAnalyst = message("m_2", "2026-08-25T10:01:00.000Z", [
  { kind: "bot_message_received", fromBotId: "b_2", fromBotName: "Analyst", text: "done" },
]);
const plainText = message("m_3", "2026-08-25T10:02:00.000Z", [{ kind: "text", text: "hello" }]);

describe("collapsing peer traffic out of the thread", () => {
  it("collapses a message that is only peer traffic", () => {
    expect(isPeerOnlyMessage(sentToAnalyst)).toBe(true);
    expect(isPeerOnlyMessage(replyFromAnalyst)).toBe(true);
  });

  it("leaves ordinary messages in the thread", () => {
    expect(isPeerOnlyMessage(plainText)).toBe(false);
    expect(isPeerOnlyMessage(message("m_4", "2026-08-25T10:03:00.000Z", []))).toBe(false);
  });

  it("keeps a mixed message in the thread rather than hiding its other blocks", () => {
    const mixed = message("m_5", "2026-08-25T10:04:00.000Z", [
      { kind: "text", text: "working on it" },
      { kind: "bot_message_sent", toBotId: "b_2", toBotName: "Analyst", text: "chart q3" },
    ]);
    expect(isPeerOnlyMessage(mixed)).toBe(false);
  });
});

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
