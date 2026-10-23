import { createCipheriv, createHash } from "node:crypto";
import type { HttpInstance } from "@larksuiteoapi/node-sdk";
import type { AdapterContext, MessagingInboundEvent } from "@rakazo/adapter-kit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChatSdkMessagingSurface } from "./chat-sdk-surface.js";
import { LazyLarkAdapter } from "./lark/lazy-adapter.js";
import { Domain, decodeThreadId, encodeThreadId } from "./lark/thread-id.js";
import { messagingPlatformsFromEnv } from "./messaging-platforms.js";

const { request } = vi.hoisted(() => ({ request: vi.fn() }));

// Exercise the real adapter and SDK; replace only outbound HTTP.
const httpInstance: HttpInstance = {
  request,
  get: request,
  delete: request,
  head: request,
  options: request,
  put: request,
  patch: request,
  post: (url: string, data: unknown) => request({ url, data, method: "POST" }),
};

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
  const platforms = messagingPlatformsFromEnv(
    {
      larkAppId: "cli-test",
      larkAppSecret: "test-app-secret",
      larkVerificationToken: token,
      ...(encrypted ? { larkEncryptKey: encryptKey } : {}),
    },
    { larkTransport: httpInstance },
  );
  const surface = new ChatSdkMessagingSurface(platforms);
  const events: MessagingInboundEvent[] = [];
  surface.onInbound(async (event) => {
    events.push(event);
  });
  return { surface, events, adapter: platforms[0]!.adapter };
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

function encryptedWebhook(payload: unknown, validSignature = true, pretty = false) {
  const iv = Buffer.alloc(16, 1);
  const key = createHash("sha256").update(encryptKey).digest();
  const cipher = createCipheriv("aes-256-cbc", key, iv);
  const encrypt = Buffer.concat([
    iv,
    cipher.update(JSON.stringify(payload)),
    cipher.final(),
  ]).toString("base64");
  const body = pretty ? JSON.stringify({ encrypt }, null, 2) : JSON.stringify({ encrypt });
  const timestamp = "1700000000";
  const nonce = "test-nonce";
  const signature = createHash("sha256")
    .update(timestamp + nonce + encryptKey + body)
    .digest("hex");
  return new Request("https://rakazo.test/api/v1/messaging/webhook/lark", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-lark-request-timestamp": timestamp,
      "x-lark-request-nonce": nonce,
      "x-lark-signature": validSignature ? signature : "invalid",
    },
    body,
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
    if (url.endsWith("/im/v1/messages/om-reply")) {
      return { code: 0 };
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

  it.each([true, false])(
    "verifies encrypted signatures against the raw body (raw signature: %s)",
    async (rawSignature) => {
      const { surface, events } = createSurface(true);
      const request = encryptedWebhook(message(), true, true);
      const body = await request.clone().text();
      expect(body).not.toBe(JSON.stringify(JSON.parse(body)));
      if (!rawSignature) {
        request.headers.set(
          "x-lark-signature",
          createHash("sha256")
            .update(
              request.headers.get("x-lark-request-timestamp")! +
                request.headers.get("x-lark-request-nonce")! +
                encryptKey +
                JSON.stringify(JSON.parse(body)),
            )
            .digest("hex"),
        );
      }
      const response = await surface.handleWebhook("lark", request);
      expect(response?.status).toBe(rawSignature ? 200 : 403);
      expect(events).toEqual(
        rawSignature
          ? [expect.objectContaining({ type: "message", provider: "lark", content: "hello" })]
          : [],
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
  it.each([false, true])(
    "rejects unauthenticated URL verification (encrypted: %s)",
    async (encrypted) => {
      const { surface } = createSurface(encrypted);
      const payload = { type: "url_verification", token: "wrong-token", challenge: "challenge" };
      expect(
        (
          await surface.handleWebhook(
            "lark",
            encrypted ? encryptedWebhook(payload) : webhook(payload),
          )
        )?.status,
      ).toBe(403);
    },
  );

  it("rejects malformed JSON and encrypted payloads", async () => {
    const { adapter } = createSurface();
    expect(
      (
        await adapter.handleWebhook(
          new Request("https://example.test", { method: "POST", body: "{" }),
        )
      ).status,
    ).toBe(400);
    expect((await adapter.handleWebhook(webhook({ encrypt: "invalid" }))).status).toBe(403);
  });

  it("preserves encoded chat and thread IDs byte for byte", () => {
    expect(encodeThreadId({ chatId: "oc-test" })).toBe("lark:b2MtdGVzdA");
    expect(encodeThreadId({ chatId: "oc-test", threadId: "omt-test" })).toBe(
      "lark:b2MtdGVzdA:b210LXRlc3Q",
    );
    expect(decodeThreadId("lark:b2MtdGVzdA:b210LXRlc3Q")).toEqual({
      chatId: "oc-test",
      threadId: "omt-test",
    });
    expect(() => decodeThreadId("slack:abc")).toThrow("Invalid thread ID prefix");
    expect(() => decodeThreadId("lark:")).toThrow("missing chatId");
  });

  it("edits and deletes text messages through the SDK", async () => {
    const { surface, adapter } = createSurface();
    await surface.handleWebhook("lark", webhook(message()));
    const threadId = encodeThreadId({ chatId: "oc-test" });
    expect(
      await adapter.editMessage(threadId, "om-reply", { markdown: "**edited**" }),
    ).toMatchObject({ id: "om-reply", threadId });
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "PUT",
        data: { msg_type: "text", content: JSON.stringify({ text: "**edited**" }) },
      }),
    );
    await adapter.deleteMessage(threadId, "om-reply");
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ method: "DELETE" }));
  });

  it("fails outbound delivery on API errors", async () => {
    const { surface, adapter } = createSurface();
    await surface.handleWebhook("lark", webhook(message()));
    request.mockResolvedValueOnce({ code: 230001, msg: "Request rejected" });
    await expect(
      adapter.postMessage(encodeThreadId({ chatId: "oc-test" }), "reply"),
    ).rejects.toThrow("230001");
  });

  it("renders post content and links", async () => {
    const { surface, events } = createSurface();
    const payload = message();
    payload.event.message.message_type = "post";
    payload.event.message.content = JSON.stringify({
      post: {
        en_us: {
          title: "Title",
          content: [
            [
              { tag: "text", text: "See " },
              { tag: "a", text: "guide", href: "https://example.test/guide" },
            ],
          ],
        },
      },
    });
    await surface.handleWebhook("lark", webhook(payload));
    expect(events).toEqual([
      expect.objectContaining({ content: "Title\n\nSee guide (https://example.test/guide)" }),
    ]);
  });

  it.each<[string, unknown, string]>([
    [
      "direct with title first",
      { title: "Title", content: [[{ tag: "text", text: "Hello" }]] },
      "# Title\nHello",
    ],
    ["direct without title", { content: [[{ tag: "text", text: "Hello" }]] }, "Hello"],
    [
      "direct with empty title",
      { title: "", content: [[{ tag: "text", text: "Hello" }]] },
      "Hello",
    ],
    ...["zh_cn", "en_us", "ja_jp"].flatMap<[string, unknown, string]>((locale) => {
      const post = { [locale]: { title: "Title", content: [[{ tag: "text", text: "Hello" }]] } };
      return [
        [locale, post, "# Title\nHello"],
        [`post.${locale}`, { post }, "# Title\nHello"],
      ];
    }),
    [
      "unsupported tags",
      {
        en_us: {
          title: "",
          content: [
            [
              { tag: "text", text: "Hello" },
              { tag: "img", image_key: "test-image", text: "ignored" },
              { tag: "unknown", text: "ignored" },
              { tag: "at", user_name: "Test bot" },
            ],
          ],
        },
      },
      "Hello@Test bot",
    ],
  ])("parses rich-text posts: %s", async (_name, content, expected) => {
    const { surface, adapter } = createSurface();
    await surface.handleWebhook(
      "lark",
      webhook({ type: "url_verification", token, challenge: "test" }),
    );
    const payload = message();
    payload.event.message.message_type = "post";
    payload.event.message.content = JSON.stringify(content);
    expect(adapter.parseMessage(payload.event).text).toBe(expected);
  });

  it("uses the selected API origin and keeps typing passive", async () => {
    const adapter = new LazyLarkAdapter({
      appId: "test-app",
      appSecret: "test-secret",
      verificationToken: token,
      encryptKey: "",
      domain: Domain.Lark,
      httpInstance,
    });
    await adapter.startTyping();
    expect(request).not.toHaveBeenCalled();
    await adapter.openDM!("ou-test");
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ url: "https://open.larksuite.com/open-apis/im/v1/chats" }),
    );
    expect(adapter.isDM(encodeThreadId({ chatId: "oc-test" }))).toBe(true);
  });
});
