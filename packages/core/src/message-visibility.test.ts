import type { ThreadMessage } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { expandPeerReplies, foldPeerReplies, userVisibleMessages } from "./message-visibility.js";

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
    },
  ]),
  message("activity", "run-peer", [{ kind: "steps", steps: [{ label: "Message bot", count: 1 }] }]),
  message("reply", "run-peer", [{ kind: "text", text: "Sent Coder the endpoints." }]),
  message("answer", "run-user", [{ kind: "text", text: "Coder is checking it." }]),
];

describe("user-visible messages", () => {
  it("hides peer activity but keeps the bot's text reply when there is no marker to fold it under", () => {
    expect(userVisibleMessages(peerExchange).map((item) => item.id)).toEqual([
      "user",
      "reply",
      "answer",
    ]);
  });

  it("keeps compact peer receipts when includePeerReceipts is set", () => {
    expect(
      userVisibleMessages(peerExchange, { includePeerReceipts: true }).map((item) => item.id),
    ).toEqual(["user", "sent", "received", "answer"]);
  });

  it("folds peer-run replies under their received marker", () => {
    const messages = [
      ...peerExchange,
      message("fallback", "run-peer", [{ kind: "text", text: "Update from Coder: Done." }]),
    ];
    const transcript = foldPeerReplies(messages, { includePeerReceipts: true });

    expect(transcript.messages.map((item) => item.id)).toEqual([
      "user",
      "sent",
      "received",
      "answer",
    ]);
    expect(transcript.folded.get("received")?.map((item) => item.id)).toEqual([
      "reply",
      "fallback",
    ]);
  });

  it("keeps peer-run user-input cards inline while folding the reply", () => {
    const messages = [
      ...peerExchange,
      message("ask", "run-peer", [{ kind: "ask", text: "Pick one", status: "pending" }]),
      message("choice", "run-peer", [
        { kind: "choice", question: "Which?", options: [{ id: "a", letter: "A", label: "A" }] },
      ]),
    ];
    const transcript = foldPeerReplies(messages, { includePeerReceipts: true });

    expect(transcript.messages.map((item) => item.id)).toEqual([
      "user",
      "sent",
      "received",
      "answer",
      "ask",
      "choice",
    ]);
    expect(transcript.folded.get("received")?.map((item) => item.id)).toEqual(["reply"]);
  });

  it("draws expanded folds right after their marker", () => {
    const transcript = foldPeerReplies(peerExchange, { includePeerReceipts: true });

    expect(expandPeerReplies(transcript, new Set()).map((item) => item.id)).toEqual([
      "user",
      "sent",
      "received",
      "answer",
    ]);
    expect(expandPeerReplies(transcript, new Set(["received"])).map((item) => item.id)).toEqual([
      "user",
      "sent",
      "received",
      "reply",
      "answer",
    ]);
  });

  it("keeps sidebar previews ask-only", () => {
    expect(
      userVisibleMessages(peerExchange, { includeDelegatedReplyText: false }).map((m) => m.id),
    ).toEqual(["user", "answer"]);
  });

  it("uses authoritative peer run ids when the receipt is outside the loaded page", () => {
    const messages = [
      message("activity", "run-peer", [
        { kind: "steps", steps: [{ label: "Echoed peer reply", count: 1 }] },
      ]),
      message("reply", "run-peer", [{ kind: "text", text: "Echoed peer reply" }]),
      message("answer", "run-user", [{ kind: "text", text: "Visible answer" }]),
    ];

    expect(
      userVisibleMessages(messages, { knownPeerRunIds: ["run-peer"] }).map((item) => item.id),
    ).toEqual(["reply", "answer"]);
  });

  it("keeps a peer-run ask card and text reply while hiding other peer activity", () => {
    const messages = [
      message("ask", "run-peer", [
        {
          kind: "ask",
          text: "Pick one",
          status: "pending",
          actions: [{ id: "a", label: "A" }],
        },
      ]),
      message("activity", "run-peer", [{ kind: "steps", steps: [{ label: "Work", count: 1 }] }]),
      message("reply", "run-peer", [{ kind: "text", text: "Peer body" }]),
      message("answer", "run-user", [{ kind: "text", text: "Visible answer" }]),
    ];

    expect(
      userVisibleMessages(messages, { knownPeerRunIds: ["run-peer"] }).map((item) => item.id),
    ).toEqual(["ask", "reply", "answer"]);
  });

  it("hides background ticket-run output except user-input cards", () => {
    const background = [
      message("wake", "run-ticket", [{ kind: "text", text: "Ticket check prompt" }]),
      message("steps", "run-ticket", [
        { kind: "steps", steps: [{ label: "Ticket comment", count: 2 }] },
      ]),
      {
        ...message("progress", "run-ticket", [{ kind: "text", text: "Working on it" }]),
        clientNonce: "user-progress:run-ticket:0",
      },
      message("ask", "run-ticket", [{ kind: "ask", text: "Choose" }]),
      message("computer", "run-ticket", [
        { kind: "computer", state: "Needs you", text: "Sign in" },
      ]),
      message("approval", "run-ticket", [
        {
          kind: "mcp_approval",
          serverId: "server-1",
          name: "Test",
          transport: "streamable_http",
          endpoint: "https://example.com/mcp",
          needsOAuth: true,
          status: "pending",
        },
      ]),
      message("final", "run-ticket", [{ kind: "text", text: "Done, closed the ticket." }]),
      message("user", "run-user", [{ kind: "text", text: "Visible answer" }]),
    ];

    expect(
      userVisibleMessages(background, { backgroundRunIds: ["run-ticket"] }).map((m) => m.id),
    ).toEqual(["ask", "computer", "approval", "user"]);
  });
});
