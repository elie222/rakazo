import type { MessagingInboundMessage, MessagingSurface } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { createMessagingTeamChatSender, toTeamChatInbound } from "./team-chat-messaging.js";

function baseEvent(overrides: Partial<MessagingInboundMessage> = {}): MessagingInboundMessage {
  return {
    type: "message",
    provider: "slack",
    handle: "Ev1",
    threadId: "slack:C1",
    isDirect: false,
    from: "U1",
    fromLabel: "Ada",
    channelName: "launch",
    participants: ["U1", "U2"],
    content: "Ship Friday?",
    mediaUrl: null,
    ...overrides,
  };
}

describe("toTeamChatInbound", () => {
  it("returns null when content and media are empty", () => {
    expect(toTeamChatInbound(baseEvent({ content: "  ", mediaUrl: null }))).toBeNull();
  });

  it("appends mediaUrl to content", () => {
    const mapped = toTeamChatInbound(
      baseEvent({ content: "see this", mediaUrl: "https://cdn.example/a.png" }),
    );
    expect(mapped?.content).toBe("see this\nhttps://cdn.example/a.png");
  });

  it("marks directs as direct", () => {
    expect(toTeamChatInbound(baseEvent({ isDirect: true }))?.kind).toBe("direct");
  });

  it("uses conversationKey and workspaceId when provided", () => {
    const mapped = toTeamChatInbound(
      baseEvent({
        workspaceId: "T1",
        conversationKey: "channel:C1",
        kind: "mention",
        replyThreadId: "100.1",
        senderIsBot: true,
        participantNames: ["Ada", "Grace"],
      }),
    );
    expect(mapped).toMatchObject({
      eventId: "Ev1",
      workspaceId: "T1",
      kind: "mention",
      conversationKey: "channel:C1",
      conversationId: "slack:C1",
      replyThreadId: "100.1",
      senderIsBot: true,
      participantNames: ["Ada", "Grace"],
    });
  });

  it("falls back workspaceId to provider and conversationKey to threadId", () => {
    const mapped = toTeamChatInbound(baseEvent());
    expect(mapped?.workspaceId).toBe("slack");
    expect(mapped?.conversationKey).toBe("slack:C1");
    expect(mapped?.kind).toBe("ambient");
  });

  it("treats @mentions as mention when kind is omitted", () => {
    expect(toTeamChatInbound(baseEvent({ content: "hey @rakazo look" }))?.kind).toBe("mention");
  });
});

describe("createMessagingTeamChatSender", () => {
  it("posts through messaging.sendToThread", async () => {
    const sendToThread = vi.fn(async () => ({ handle: "msg-1" }));
    const messaging = { sendToThread } as unknown as MessagingSurface;
    const send = createMessagingTeamChatSender(messaging);
    await expect(
      send({
        conversationId: "slack:C1",
        replyThreadId: "100.1",
        content: "Done",
      }),
    ).resolves.toEqual({ handle: "msg-1" });
    expect(sendToThread).toHaveBeenCalledWith(
      { threadId: "slack:C1", body: "Done" },
      expect.objectContaining({
        operationId: expect.stringMatching(/^team-chat-send:/),
        spaceId: "",
        userId: "",
      }),
    );
  });

  it("forwards idempotencyKey into the messaging send and operation id", async () => {
    const sendToThread = vi.fn(async () => ({ handle: "msg-2" }));
    const messaging = { sendToThread } as unknown as MessagingSurface;
    const send = createMessagingTeamChatSender(messaging);
    await expect(
      send({
        conversationId: "slack:C1",
        replyThreadId: null,
        content: "Retry safe",
        idempotencyKey: "external-message:m-1",
      }),
    ).resolves.toEqual({ handle: "msg-2" });
    expect(sendToThread).toHaveBeenCalledWith(
      {
        threadId: "slack:C1",
        body: "Retry safe",
        idempotencyKey: "external-message:m-1",
      },
      expect.objectContaining({
        operationId: "team-chat-send:external-message:m-1",
      }),
    );
  });
});
