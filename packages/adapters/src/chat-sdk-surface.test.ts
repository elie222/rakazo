import { createMockAdapter, createTestMessage } from "@chat-adapter/tests";
import type { AdapterContext, MessagingInboundEvent } from "@rakazo/adapter-kit";
import type { Adapter, ChatInstance } from "chat";
import { describe, expect, it, vi } from "vitest";
import {
  ChatSdkMessagingSurface,
  MESSAGING_WEBHOOK_MAX_BODY_BYTES,
  type MessagingPlatform,
  providerOfThreadId,
} from "./chat-sdk-surface.js";

const context: AdapterContext = {
  operationId: "op-1",
  traceId: "trace-1",
  spaceId: "ws-1",
  userId: "user-1",
  signal: new AbortController().signal,
};

/**
 * A mock Chat SDK adapter whose webhook drives the real Chat instance. Like
 * the real Sendblue/Telegram/WhatsApp adapters, handleWebhook fires
 * processMessage without awaiting it and registers the work via waitUntil.
 * Mock thread ids are DMs when the channel segment starts with "D".
 */
function createPlatform(
  overrides: Partial<MessagingPlatform> = {},
  adapterOverrides: Partial<Adapter> = {},
) {
  let chat: ChatInstance | undefined;
  const adapter: Adapter = createMockAdapter("mock", {
    initialize: vi.fn(async (instance: ChatInstance) => {
      chat = instance;
    }),
    handleWebhook: vi.fn(
      async (request: Request, options?: { waitUntil?: (task: Promise<unknown>) => void }) => {
        const payload = (await request.json()) as {
          threadId: string;
          id: string;
          text: string;
          isMe?: boolean;
        };
        // Fire-and-forget: matches Chat SDK adapters that return 200 before
        // processMessage settles, relying on waitUntil for background work.
        chat!.processMessage(
          adapter,
          payload.threadId,
          createTestMessage(payload.id, payload.text, {
            threadId: payload.threadId,
            raw: { roster: ["+15551111111", "+15552222222"] },
            author: {
              userId: "U123",
              userName: "testuser",
              fullName: "Test User",
              isBot: false,
              isMe: payload.isMe ?? false,
            },
          }),
          options,
        );
        return new Response("ok");
      },
    ),
    // Force thread.post through postMessage, the surface's send path.
    postChannelMessage: undefined,
    ...adapterOverrides,
  });
  const platform: MessagingPlatform = {
    provider: "mock",
    capabilities: { direct: true, groups: true, typing: true },
    adapter,
    ...overrides,
  };
  return { adapter, platform, getChat: () => chat! };
}

function createSurface(
  overrides: Partial<MessagingPlatform> = {},
  adapterOverrides: Partial<Adapter> = {},
) {
  const { adapter, platform, getChat } = createPlatform(overrides, adapterOverrides);
  const surface = new ChatSdkMessagingSurface([platform]);
  const events: MessagingInboundEvent[] = [];
  surface.onInbound(async (event) => {
    events.push(event);
  });
  return { adapter, platform, surface, events, getChat };
}

function webhookRequest(payload: unknown): Request {
  return new Request("https://rakazo.test/api/v1/messaging/webhook/mock", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

describe("ChatSdkMessagingSurface inbound", () => {
  it("normalizes a DM into a provider-neutral inbound message", async () => {
    const { surface, events } = createSurface();
    const response = await surface.handleWebhook(
      "mock",
      webhookRequest({ threadId: "mock:Duser:1", id: "m-1", text: "hello" }),
    );

    expect(response?.status).toBe(200);
    expect(events).toEqual([
      {
        type: "message",
        provider: "mock",
        handle: "m-1",
        threadId: "mock:Duser:1",
        isDirect: true,
        from: "U123",
        fromLabel: "Test User",
        channelName: null,
        participants: [],
        content: "hello",
        mediaUrl: null,
      },
    ]);
  });

  it("never surfaces the bot's own messages", async () => {
    const { surface, events } = createSurface();
    const response = await surface.handleWebhook(
      "mock",
      webhookRequest({ threadId: "mock:Duser:1", id: "m-1", text: "echo", isMe: true }),
    );

    expect(response?.status).toBe(200);
    expect(events).toHaveLength(0);
  });

  it("delivers non-DM events with the platform's roster hooks when groups are supported", async () => {
    const { surface, events } = createSurface({
      participants: (raw) => (raw as { roster: string[] }).roster,
      channelName: () => "The Group",
    });
    await surface.handleWebhook(
      "mock",
      webhookRequest({ threadId: "mock:C1:9", id: "m-2", text: "group hello" }),
    );

    expect(events).toEqual([
      expect.objectContaining({
        type: "message",
        isDirect: false,
        participants: ["+15551111111", "+15552222222"],
        channelName: "The Group",
        content: "group hello",
      }),
    ]);
  });

  it("drops non-DM events for platforms without group support", async () => {
    const { surface, events } = createSurface({
      capabilities: { direct: true, groups: false, typing: false },
    });
    const response = await surface.handleWebhook(
      "mock",
      webhookRequest({ threadId: "mock:C1:9", id: "m-3", text: "group hello" }),
    );

    expect(response?.status).toBe(200);
    expect(events).toHaveLength(0);
  });

  it("still delivers a follow-up after the thread is subscribed", async () => {
    // Chat SDK routes post-subscribe messages only to onSubscribedMessage;
    // without that handler the catch-all never sees them.
    const { surface, events, getChat } = createSurface({
      participants: (raw) => (raw as { roster: string[] }).roster,
    });
    const threadId = "mock:C1:9";
    await surface.handleWebhook("mock", webhookRequest({ threadId, id: "m-sub-1", text: "first" }));
    expect(events).toHaveLength(1);

    await getChat().getState().subscribe(threadId);

    await surface.handleWebhook(
      "mock",
      webhookRequest({ threadId, id: "m-sub-2", text: "second" }),
    );
    expect(events.map((event) => event.handle)).toEqual(["m-sub-1", "m-sub-2"]);
  });

  it("delivers overlapping messages on one conversation instead of dropping them", async () => {
    const { platform } = createPlatform();
    const surface = new ChatSdkMessagingSurface([platform]);
    const delivered: string[] = [];
    surface.onInbound(async (event) => {
      delivered.push(event.handle);
      // The real sink writes to the database and enqueues a run, so the
      // second webhook lands while the first is still in flight.
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    const [first, second] = await Promise.all([
      surface.handleWebhook(
        "mock",
        webhookRequest({ threadId: "mock:Duser:1", id: "m-4", text: "one" }),
      ),
      surface.handleWebhook(
        "mock",
        webhookRequest({ threadId: "mock:Duser:1", id: "m-5", text: "two" }),
      ),
    ]);

    expect([first?.status, second?.status]).toEqual([200, 200]);
    // A dropped message would ACK 200 with no vendor retry, losing it for good.
    expect(delivered.sort()).toEqual(["m-4", "m-5"]);
  });
});

describe("ChatSdkMessagingSurface webhook waitUntil drain", () => {
  it("does not return 2xx until the inbound sink finishes", async () => {
    const { adapter, platform } = createPlatform();
    const surface = new ChatSdkMessagingSurface([platform]);
    let sinkDone = false;
    let sawSinkPendingAtResponse = false;
    surface.onInbound(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      sinkDone = true;
    });

    const responsePromise = surface.handleWebhook(
      "mock",
      webhookRequest({ threadId: "mock:Duser:1", id: "m-slow", text: "hello" }),
    );
    // If the surface returned before draining waitUntil, sinkDone would still be false
    // when the promise settles... we assert after await that sink completed first.
    const response = await responsePromise;
    sawSinkPendingAtResponse = !sinkDone;
    expect(sawSinkPendingAtResponse).toBe(false);
    expect(sinkDone).toBe(true);
    expect(response?.status).toBe(200);
    expect(adapter.handleWebhook).toHaveBeenCalled();
  });

  it("returns 5xx when the inbound sink throws so the vendor can retry", async () => {
    const { platform } = createPlatform();
    const surface = new ChatSdkMessagingSurface([platform]);
    surface.onInbound(async () => {
      throw new Error("provision failed");
    });

    const response = await surface.handleWebhook(
      "mock",
      webhookRequest({ threadId: "mock:Duser:1", id: "m-fail", text: "hello" }),
    );

    expect(response?.status).toBe(500);
  });
});

describe("ChatSdkMessagingSurface webhook plumbing", () => {
  it("returns null for a provider it does not host", () => {
    const { surface } = createSurface();
    expect(surface.handleWebhook("nope", webhookRequest({}))).toBeNull();
  });

  it("rejects oversized bodies before they reach the adapter", async () => {
    const { surface, adapter } = createSurface();
    const response = await surface.handleWebhook(
      "mock",
      new Request("https://rakazo.test/api/v1/messaging/webhook/mock", {
        method: "POST",
        body: "x".repeat(MESSAGING_WEBHOOK_MAX_BODY_BYTES + 1),
      }),
    );

    expect(response?.status).toBe(413);
    expect(adapter.handleWebhook).not.toHaveBeenCalled();
  });

  it("peeks status payloads only after the adapter accepted the request", async () => {
    const peekStatus = () =>
      ({ type: "status", provider: "mock", handle: "h-1", status: "SENT" }) as const;

    const accepted = createSurface(
      { peekStatus },
      { handleWebhook: vi.fn(async () => new Response("ok")) },
    );
    await accepted.surface.handleWebhook("mock", webhookRequest({ is_outbound: true }));
    expect(accepted.events).toEqual([
      { type: "status", provider: "mock", handle: "h-1", status: "SENT" },
    ]);

    // A forged webhook the adapter rejects must not flip outbox rows.
    const rejected = createSurface(
      { peekStatus },
      { handleWebhook: vi.fn(async () => new Response("no", { status: 401 })) },
    );
    const response = await rejected.surface.handleWebhook(
      "mock",
      webhookRequest({ is_outbound: true }),
    );
    expect(response?.status).toBe(401);
    expect(rejected.events).toHaveLength(0);
  });
});

describe("ChatSdkMessagingSurface outbound", () => {
  it("posts to a thread through the platform adapter and returns the handle", async () => {
    const { surface, adapter } = createSurface();
    const result = await surface.sendToThread({ threadId: "mock:C1:9", body: "hi" }, context);

    expect(result).toEqual({ handle: "msg-1" });
    expect(adapter.postMessage).toHaveBeenCalledTimes(1);
    expect((adapter.postMessage as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toBe("mock:C1:9");
  });

  it("prefers the platform's deterministic direct thread id", async () => {
    const { surface, adapter } = createSurface({
      directThreadId: (address) => `mock:D${address}:pinned`,
    });
    await expect(surface.openDirectThread("mock", "+15551234567", context)).resolves.toBe(
      "mock:D+15551234567:pinned",
    );
    expect(adapter.openDM).not.toHaveBeenCalled();
  });

  it("falls back to the adapter's openDM", async () => {
    const { surface, adapter } = createSurface();
    await expect(surface.openDirectThread("mock", "+15551234567", context)).resolves.toBe(
      "mock:D+15551234567:",
    );
    expect(adapter.openDM).toHaveBeenCalledWith("+15551234567");
  });

  it("throws when the platform cannot open direct conversations", async () => {
    const { surface } = createSurface({}, { openDM: undefined });
    await expect(surface.openDirectThread("mock", "+15551234567", context)).rejects.toThrow(
      /cannot open direct/,
    );
  });

  it("throws for an unknown provider", async () => {
    const { surface } = createSurface();
    await expect(surface.openDirectThread("nope", "+15551234567", context)).rejects.toThrow(
      /Unknown messaging provider/,
    );
  });
});

describe("ChatSdkMessagingSurface typing", () => {
  it("forwards typing to platforms that support it", async () => {
    const { surface, adapter } = createSurface();
    await surface.sendTyping("mock:Duser:1", context);
    expect(adapter.startTyping).toHaveBeenCalledWith("mock:Duser:1");
  });

  it("no-ops when the platform lacks typing support", async () => {
    const { surface, adapter } = createSurface({
      capabilities: { direct: true, groups: true, typing: false },
    });
    await surface.sendTyping("mock:Duser:1", context);
    expect(adapter.startTyping).not.toHaveBeenCalled();
  });

  it("no-ops for a thread on an unknown provider", async () => {
    const { surface, adapter } = createSurface();
    await surface.sendTyping("nope:Duser:1", context);
    expect(adapter.startTyping).not.toHaveBeenCalled();
  });
});

describe("ChatSdkMessagingSurface shape", () => {
  it("requires at least one platform and reports the mounted ones", () => {
    expect(() => new ChatSdkMessagingSurface([])).toThrow(/>=1 platform/);
    const { surface } = createSurface();
    expect(surface.platforms()).toEqual([
      { provider: "mock", capabilities: { direct: true, groups: true, typing: true } },
    ]);
    expect(surface.describe().capabilities).toEqual({ providers: ["mock"] });
    expect(providerOfThreadId("mock:C1:9")).toBe("mock");
  });
});
