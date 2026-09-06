import { createCipheriv, createHash } from "node:crypto";
import type { AdapterContext, MessagingInboundEvent } from "@rakazo/adapter-kit";
import type { HttpInstance } from "chat-adapter-lark";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChatSdkMessagingSurface } from "./chat-sdk-surface.js";
import { messagingPlatformsFromEnv } from "./messaging-platforms.js";

const { request } = vi.hoisted(() => ({ request: vi.fn() }));

// Exercise the pinned adapter and SDK; replace only their outbound HTTP boundary.
vi.mock("chat-adapter-lark", async (importOriginal) => {
  const actual = await importOriginal<typeof import("chat-adapter-lark")>();
  return {
    ...actual,
    createLarkAdapter: (config: Parameters<typeof actual.createLarkAdapter>[0]) =>
      actual.createLarkAdapter({
        ...config,
        httpInstance: {
          request,
          get: request,
          delete: request,
          head: request,
          options: request,
          put: request,
          patch: request,
          post: (url: string, data: unknown) => request({ url, data, method: "POST" }),
        } satisfies HttpInstance,
      }),
  };
});

const context: AdapterContext = {
  operationId: "op-test",
  traceId: "trace-test",
  spaceId: "space-test",
  userId: "user-test",
  signal: new AbortController().signal,
};
const token = "test-verification-token";
const encryptKey = "test-encryption-key";

function createSurface(encrypted = false) {
  const platforms = messagingPlatformsFromEnv({
    larkAppId: "cli-test",
    larkAppSecret: "test-app-secret",
    larkVerificationToken: token,
    ...(encrypted ? { larkEncryptKey: encryptKey } : {}),
  });
  const surface = new ChatSdkMessagingSurface(platforms);
  const events: MessagingInboundEvent[] = [];
  surface.onInbound(async (event) => {
    events.push(event);
  });
  return { surface, events };
}

function message(chatType = "p2p", sender = "ou-test") {
  return {
    schema: "2.0",
    header: { event_type: "im.message.receive_v1", event_id: "event-test", token },
    event: {
      sender: { sender_type: "user", sender_id: { open_id: sender } },
      message: {
        message_id: "om-test",
        chat_id: "oc-test",
        chat_type: chatType,
        message_type: "text",
        content: JSON.stringify({ text: "hello" }),
        create_time: "1700000000000",
      },
    },
  };
}

function webhook(body: unknown, headers: Record<string, string> = {}) {
  return new Request("https://rakazo.test/api/v1/messaging/webhook/lark", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function encryptedWebhook(payload: unknown, validSignature = true) {
  const iv = Buffer.alloc(16, 1);
  const key = createHash("sha256").update(encryptKey).digest();
  const cipher = createCipheriv("aes-256-cbc", key, iv);
  const encrypt = Buffer.concat([
    iv,
    cipher.update(JSON.stringify(payload)),
    cipher.final(),
  ]).toString("base64");
  const body = { encrypt };
  const timestamp = "1700000000";
  const nonce = "test-nonce";
  const signature = createHash("sha256")
    .update(timestamp + nonce + encryptKey + JSON.stringify(body))
    .digest("hex");
  return webhook(body, {
    "x-lark-request-timestamp": timestamp,
    "x-lark-request-nonce": nonce,
    "x-lark-signature": validSignature ? signature : "invalid",
  });
}

beforeEach(() => {
  request.mockReset();
  request.mockImplementation(async ({ url }: { url: string }) => {
    if (url.endsWith("/auth/v3/tenant_access_token/internal")) {
      return { code: 0, tenant_access_token: "test-access-token", expire: 7200 };
    }
    if (url.endsWith("/bot/v3/info")) {
      return { code: 0, bot: { open_id: "ou-bot", app_name: "Test bot" } };
    }
    if (url.endsWith("/contact/v3/users/ou-test")) {
      return { code: 0, data: { user: { name: "Test user" } } };
    }
    if (url.endsWith("/im/v1/messages")) {
      return { code: 0, data: { message_id: "om-reply" } };
    }
    if (url.endsWith("/im/v1/chats")) {
      return { code: 0, data: { chat_id: "oc-test" } };
    }
    throw new Error(`Unexpected HTTP request: ${url}`);
  });
});

describe("Lark messaging conformance", () => {
  it.each([undefined, "wrong-token"])("rejects a webhook with token %s", async (invalidToken) => {
    const { surface, events } = createSurface();
    const payload = message();
    const response = await surface.handleWebhook(
      "lark",
      webhook({ ...payload, header: { ...payload.header, token: invalidToken } }),
    );
    expect(response?.status).toBe(403);
    expect(events).toEqual([]);
  });

  it.each([false, true])(
    "answers authenticated URL verification (encrypted: %s)",
    async (encrypted) => {
      const { surface, events } = createSurface(encrypted);
      const payload = { type: "url_verification", token, challenge: "test-challenge" };
      const response = await surface.handleWebhook(
        "lark",
        encrypted ? encryptedWebhook(payload) : webhook(payload),
      );
      expect(response?.status).toBe(200);
      expect(await response?.json()).toEqual({ challenge: "test-challenge" });
      expect(events).toEqual([]);
    },
  );

  it.each([false, true])(
    "delivers direct messages and sends replies (encrypted: %s)",
    async (encrypted) => {
      const { surface, events } = createSurface(encrypted);
      const response = await surface.handleWebhook(
        "lark",
        encrypted ? encryptedWebhook(message()) : webhook(message()),
      );
      expect(response?.status).toBe(200);
      expect(events).toEqual([
        expect.objectContaining({
          type: "message",
          provider: "lark",
          isDirect: true,
          from: "ou-test",
          handle: "om-test",
          content: "hello",
        }),
      ]);
      const threadId = await surface.openDirectThread("lark", "ou-test", context);
      expect(await surface.sendToThread({ threadId, body: "reply" }, context)).toEqual({
        handle: "om-reply",
      });
      expect(request).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ receive_id: "oc-test" }),
        }),
      );
    },
  );

  it("rejects an invalid encrypted signature", async () => {
    const { surface, events } = createSurface(true);
    expect((await surface.handleWebhook("lark", encryptedWebhook(message(), false)))?.status).toBe(
      403,
    );
    expect(events).toEqual([]);
  });

  it.each([
    ["group", "ou-test"],
    ["p2p", "ou-bot"],
  ])("ignores %s messages from %s", async (chatType, sender) => {
    const { surface, events } = createSurface();
    expect((await surface.handleWebhook("lark", webhook(message(chatType, sender))))?.status).toBe(
      200,
    );
    expect(events).toEqual([]);
  });

  it("returns a retryable failure when inbound persistence fails", async () => {
    const { surface } = createSurface();
    surface.onInbound(async () => {
      throw new Error("Persistence unavailable");
    });
    expect((await surface.handleWebhook("lark", webhook(message())))?.status).toBe(500);
  });
});
