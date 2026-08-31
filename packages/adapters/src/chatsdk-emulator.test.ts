import type { AdapterContext, MessagingInboundMessage } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { ChatSdkMessagingProvider } from "./chatsdk.js";
import { ChatSdkEmulator } from "./chatsdk-emulator.js";

const context: AdapterContext = {
  spaceId: "ws-1",
  userId: "user-1",
  botId: "bot-1",
  runId: "run-1",
  operationId: "op-1",
  traceId: "trace-1",
  signal: new AbortController().signal,
};

function createProvider() {
  const emulator = new ChatSdkEmulator();
  const provider = new ChatSdkMessagingProvider({
    adapters: { emulated: emulator },
    adapterName: "emulated",
  });
  return { emulator, provider };
}

describe("ChatSdkEmulator", () => {
  it("serves the provider over the injected adapter and records sends", async () => {
    const { emulator, provider } = createProvider();

    const dm = await provider.sendDirect({ to: "+15551234567", body: "hello there" }, context);
    expect(dm.handle).toBeTruthy();
    expect(emulator.sent).toEqual([{ to: "+15551234567", body: "hello there", handle: dm.handle }]);
  });

  it("records typing indicators", async () => {
    const { emulator, provider } = createProvider();

    await provider.sendTypingIndicator({ to: "+15551234567" }, context);
    expect(emulator.typingIndicators).toEqual(["+15551234567"]);
  });

  it("fails the next N sends on demand and recovers afterwards", async () => {
    const { emulator, provider } = createProvider();
    emulator.failNextSends(2);

    await expect(provider.sendDirect({ to: "+15551234567", body: "a" }, context)).rejects.toThrow(
      /emulated chat network failure/,
    );
    await expect(provider.sendDirect({ to: "+15551234567", body: "b" }, context)).rejects.toThrow(
      /emulated chat network failure/,
    );
    await provider.sendDirect({ to: "+15551234567", body: "c" }, context);
    expect(emulator.sent.map((send) => send.body)).toEqual(["c"]);
  });

  it("delivers inbound DMs through the Chat runtime to the registered handler", async () => {
    const { emulator, provider } = createProvider();
    const inbound = vi.fn<(event: MessagingInboundMessage) => Promise<void>>();
    provider.onInbound(inbound);
    await provider.initialize();

    await emulator.deliverInbound({ from: "+15551234567", text: "ping" });

    expect(inbound).toHaveBeenCalledTimes(1);
    expect(inbound.mock.calls[0]![0]).toEqual({
      type: "message",
      handle: expect.any(String),
      fromNumber: "+15551234567",
      groupId: null,
      groupName: null,
      participants: [],
      content: "ping",
      mediaUrl: null,
    });
  });

  it("drops a replayed inbound handle through chat-sdk's dedupe", async () => {
    const { emulator, provider } = createProvider();
    const inbound = vi.fn<(event: MessagingInboundMessage) => Promise<void>>();
    provider.onInbound(inbound);
    await provider.initialize();

    await emulator.deliverInbound({ from: "+15551234567", text: "once", handle: "fixed-1" });
    await emulator.deliverInbound({ from: "+15551234567", text: "twice", handle: "fixed-1" });

    expect(inbound).toHaveBeenCalledTimes(1);
  });

  it("round-trips the emulator's inbound message through the neutral parser", async () => {
    const { emulator, provider } = createProvider();
    let captured: MessagingInboundMessage | null = null;
    provider.onInbound(async (event) => {
      captured = event;
    });
    await provider.initialize();

    await emulator.deliverInbound({ from: "+15557654321", text: "structured" });

    // The provider maps the normalized chat-sdk Message via parseChatSdkInbound.
    expect(captured).toEqual({
      type: "message",
      handle: expect.any(String),
      fromNumber: "+15557654321",
      groupId: null,
      groupName: null,
      participants: [],
      content: "structured",
      mediaUrl: null,
    });
  });

  it("rejects inbound delivery before the Chat runtime is initialized", async () => {
    const emulator = new ChatSdkEmulator();
    await expect(emulator.deliverInbound({ from: "u-1", text: "hi" })).rejects.toThrow(
      /not attached/,
    );
  });
});
