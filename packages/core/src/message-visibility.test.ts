import type { ThreadMessage } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { userVisibleMessages } from "./message-visibility.js";

function message(id: string, runId: string, blocks: ThreadMessage["blocks"]): ThreadMessage {
  return {
    id,
    threadId: "thread-1",
    seq: 1,
    role: "bot",
    blocks,
    runId,
    createdAt: "2026-08-30T22:00:00.000Z",
  };
}

describe("user-visible messages", () => {
  it("keeps bot-to-bot exchanges out of the user transcript", () => {
    const messages = [
      message("user", "run-user", [{ kind: "text", text: "Please ask Coder." }]),
      message("sent", "run-user", [
        { kind: "bot_message_sent", toBotId: "coder", toBotName: "Coder", text: "Check this." },
      ]),
      message("received", "run-peer", [
        {
          kind: "bot_message_received",
          fromBotId: "coder",
          fromBotName: "Coder",
          text: "Done.",
        },
      ]),
      message("activity", "run-peer", [
        { kind: "steps", steps: [{ label: "Message bot", count: 1 }] },
      ]),
      message("reply", "run-peer", [{ kind: "text", text: "Sent Coder the endpoints." }]),
      message("answer", "run-user", [{ kind: "text", text: "Coder is checking it." }]),
    ];

    expect(userVisibleMessages(messages).map((item) => item.id)).toEqual(["user", "answer"]);
  });

  it("uses authoritative peer run ids when the receipt is outside the loaded page", () => {
    const messages = [
      message("reply", "run-peer", [{ kind: "text", text: "Echoed peer reply" }]),
      message("answer", "run-user", [{ kind: "text", text: "Visible answer" }]),
    ];

    expect(userVisibleMessages(messages, ["run-peer"]).map((item) => item.id)).toEqual(["answer"]);
  });
});
