import { describe, expect, it } from "vitest";
import {
  createRecordingMessagingSurface,
  MessagingTeamChatEmulator,
} from "./messaging-team-chat-emulator.js";
import { createMessagingTeamChatSender, toTeamChatInbound } from "./team-chat-messaging.js";

describe("MessagingTeamChatEmulator", () => {
  it("builds inbound fixtures with team-room enrichment fields", () => {
    const emulator = new MessagingTeamChatEmulator();
    const inbound = emulator.buildInbound({
      content: "hello room",
      kind: "mention",
      replyThreadId: "ts-1",
      participantNames: ["Ada", "Grace"],
    });
    expect(inbound.provider).toBe("teamchat-emulator");
    expect(inbound.workspaceId).toBe("T-emulator");
    expect(inbound.isDirect).toBe(false);
    expect(toTeamChatInbound(inbound)).toMatchObject({
      kind: "mention",
      workspaceId: "T-emulator",
      replyThreadId: "ts-1",
      participantNames: ["Ada", "Grace"],
      content: "hello room",
    });
  });

  it("exposes a MessagingPlatform with group capabilities", () => {
    const platform = new MessagingTeamChatEmulator().createPlatform();
    expect(platform).toMatchObject({
      provider: "teamchat-emulator",
      capabilities: { direct: true, groups: true, typing: false },
    });
    expect(platform.directThreadId?.("U1")).toBe("teamchat-emulator:dm:U1");
  });

  it("works with createMessagingTeamChatSender via a recording surface", async () => {
    const emulator = new MessagingTeamChatEmulator();
    const recording = createRecordingMessagingSurface(emulator);
    const send = createMessagingTeamChatSender(recording as never);
    await send({
      conversationId: "teamchat-emulator:room-2",
      replyThreadId: null,
      content: "shipped",
    });
    expect(emulator.sent[0]).toMatchObject({
      threadId: "teamchat-emulator:room-2",
      body: "shipped",
    });
  });
});
