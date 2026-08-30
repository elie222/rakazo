import { describe, expect, it } from "vitest";
import { parseSendBlueInbound, SendBlueMessagingProvider } from "./sendblue.js";
import { SendBlueEmulator } from "./sendblue-emulator.js";

const context = {
  operationId: "op-1",
  traceId: "trace-1",
  workspaceId: "ws-1",
  userId: "user-1",
  signal: new AbortController().signal,
};

describe("SendBlueEmulator", () => {
  it("serves the provider over fetch and records sends", async () => {
    const emulator = new SendBlueEmulator();
    const provider = new SendBlueMessagingProvider(
      {
        apiKeyId: "key-id",
        apiSecret: "secret",
        signingSecret: emulator.signingSecret,
        phoneNumber: emulator.phoneNumber,
      },
      { fetch: emulator.fetch },
    );

    const dm = await provider.sendDirect({ to: "+15551234567", body: "hello" }, context);
    expect(dm.handle).toBeTruthy();
    const group = await provider.sendGroup({ groupId: "grp-1", body: "hi all" }, context);
    expect(group.handle).toBeTruthy();

    expect(emulator.sent).toEqual([
      { kind: "dm", to: "+15551234567", body: "hello", handle: dm.handle },
      { kind: "group", groupId: "grp-1", body: "hi all", handle: group.handle },
    ]);
  });

  it("records typing indicators", async () => {
    const emulator = new SendBlueEmulator();
    const provider = new SendBlueMessagingProvider(
      {
        apiKeyId: "key-id",
        apiSecret: "secret",
        signingSecret: emulator.signingSecret,
        phoneNumber: emulator.phoneNumber,
      },
      { fetch: emulator.fetch },
    );

    await provider.sendTypingIndicator({ to: "+15551234567" }, context);
    expect(emulator.typingIndicators).toEqual(["+15551234567"]);
  });

  it("rejects a typing indicator with no recipient so empty sends cannot pass silently", async () => {
    const emulator = new SendBlueEmulator();
    const response = await emulator.fetch("https://api.sendblue.com/api/send-typing-indicator", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(400);
    expect(emulator.typingIndicators).toEqual([]);
  });

  it("returns registered group participants", async () => {
    const emulator = new SendBlueEmulator();
    emulator.registerGroup("grp-1", {
      name: "Family",
      participants: ["+15551111111", "+15552222222"],
    });
    const provider = new SendBlueMessagingProvider(
      {
        apiKeyId: "key-id",
        apiSecret: "secret",
        signingSecret: emulator.signingSecret,
        phoneNumber: emulator.phoneNumber,
      },
      { fetch: emulator.fetch },
    );

    await expect(provider.getGroup("grp-1", context)).resolves.toEqual({
      id: "grp-1",
      name: "Family",
      participants: ["+15551111111", "+15552222222"],
    });
  });

  it("throws on unexpected URLs", async () => {
    const emulator = new SendBlueEmulator();
    await expect(emulator.fetch("https://example.com/nope")).rejects.toThrow(/unexpected/i);
  });

  it("builds signed inbound requests that round-trip through the parser", async () => {
    const emulator = new SendBlueEmulator();
    const request = emulator.buildInboundRequest({
      fromNumber: "+15551234567",
      content: "YES",
      groupId: "grp-1",
      participants: ["+15551234567", emulator.phoneNumber],
      handle: "handle-xyz",
    });

    expect(request.method).toBe("POST");
    expect(request.headers.get("sb-signing-secret")).toBe(emulator.signingSecret);
    const parsed = parseSendBlueInbound(await request.json());
    expect(parsed).toEqual({
      type: "message",
      handle: "handle-xyz",
      fromNumber: "+15551234567",
      groupId: "grp-1",
      groupName: null,
      participants: ["+15551234567", emulator.phoneNumber],
      content: "YES",
      mediaUrl: null,
    });
  });
});
