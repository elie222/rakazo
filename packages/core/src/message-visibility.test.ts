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

const peerExchange = [
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
      intent: "result",
    },
  ]),
  message("activity", "run-peer", [{ kind: "steps", steps: [{ label: "Message bot", count: 1 }] }]),
  message("reply", "run-peer", [{ kind: "text", text: "Sent Coder the endpoints." }]),
  message("answer", "run-user", [{ kind: "text", text: "Coder is checking it." }]),
];

describe("user-visible messages", () => {
  it("keeps a bot's final peer-work summary without exposing the peer exchange", () => {
    expect(userVisibleMessages(peerExchange).map((item) => item.id)).toEqual([
      "user",
      "reply",
      "answer",
    ]);
  });

  it("keeps an assigned worker's reply out of the user transcript", () => {
    const workerExchange = [
      message("received", "run-worker", [
        {
          kind: "bot_message_received" as const,
          fromBotId: "coordinator",
          fromBotName: "Coordinator",
          text: "Check this.",
          intent: "request" as const,
        },
      ]),
      message("reply", "run-worker", [{ kind: "text", text: "The check passed." }]),
    ];

    expect(userVisibleMessages(workerExchange).map((item) => item.id)).toEqual([]);
  });

  it("keeps an assigned worker's takeover request visible", () => {
    const workerExchange = [
      message("received", "run-worker", [
        {
          kind: "bot_message_received",
          fromBotId: "coordinator",
          fromBotName: "Coordinator",
          text: "Check staging.",
          intent: "request",
        },
      ]),
      message("takeover", "run-worker", [
        { kind: "computer", state: "Ready", text: "Please complete the staging login." },
      ]),
      message("reply", "run-worker", [{ kind: "text", text: "Waiting for login." }]),
    ];

    expect(userVisibleMessages(workerExchange).map((item) => item.id)).toEqual(["takeover"]);
  });

  it("keeps compact peer receipts when includePeerReceipts is set", () => {
    expect(
      userVisibleMessages(peerExchange, { includePeerReceipts: true }).map((item) => item.id),
    ).toEqual(["user", "sent", "received", "reply", "answer"]);
  });

  it("uses authoritative peer run ids when the receipt is outside the loaded page", () => {
    const messages = [
      message("reply", "run-peer", [{ kind: "text", text: "Echoed peer reply" }]),
      message("answer", "run-user", [{ kind: "text", text: "Visible answer" }]),
    ];

    expect(
      userVisibleMessages(messages, {
        knownPeerRunIds: ["run-peer"],
        knownPeerReportRunIds: ["run-peer"],
      }).map((item) => item.id),
    ).toEqual(["reply", "answer"]);
  });

  it("keeps mid-turn peer narration hidden", () => {
    const progress = {
      ...message("progress", "run-peer", [{ kind: "text" as const, text: "Still checking." }]),
      clientNonce: "user-progress:run-peer:0:test",
    };

    expect(
      userVisibleMessages([progress], { knownPeerRunIds: ["run-peer"] }).map((item) => item.id),
    ).toEqual([]);
  });

  it("keeps untagged mid-turn text on a peer-report run hidden while a terminal summary still shows", () => {
    const messages = [
      {
        ...message("received", "run-peer", [
          {
            kind: "bot_message_received" as const,
            fromBotId: "coder",
            fromBotName: "Coder",
            text: "Done.",
            intent: "result" as const,
          },
        ]),
        seq: 1,
      },
      {
        ...message("progress", "run-peer", [
          { kind: "text" as const, text: "Still drafting the report." },
        ]),
        seq: 2,
      },
      {
        ...message("summary", "run-peer", [
          { kind: "text" as const, text: "Coder finished the review." },
        ]),
        seq: 3,
      },
    ];

    expect(userVisibleMessages(messages).map((item) => item.id)).toEqual(["summary"]);
  });

  it("picks the latest peer summary by seq when messages are newest-first", () => {
    const messages = [
      {
        ...message("summary", "run-peer", [{ kind: "text" as const, text: "Final report." }]),
        seq: 3,
      },
      {
        ...message("progress", "run-peer", [
          { kind: "text" as const, text: "Still drafting the report." },
        ]),
        seq: 2,
      },
      {
        ...message("received", "run-peer", [
          {
            kind: "bot_message_received" as const,
            fromBotId: "coder",
            fromBotName: "Coder",
            text: "Done.",
            intent: "result" as const,
          },
        ]),
        seq: 1,
      },
    ];

    expect(userVisibleMessages(messages).map((item) => item.id)).toEqual(["summary"]);
  });
});
