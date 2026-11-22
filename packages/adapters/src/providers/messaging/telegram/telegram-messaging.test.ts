import { createTelegramAdapter } from "@chat-adapter/telegram";
import type { AdapterContext, MessagingInboundEvent } from "@rakazo/adapter-kit";
import { deferred } from "@rakazo/core/test-async";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatSdkMessagingSurface } from "../../../messaging/chat-sdk-surface.js";
import type { MessagingEnvironmentValues } from "../../../messaging/messaging-platforms.js";
import {
  messagingPlatformsFromEnv,
  splitOutboundBody,
} from "../../../messaging/messaging-platforms.js";

const context: AdapterContext = {
  operationId: "op-test",
  traceId: "trace-test",
  spaceId: "space-test",
  userId: "user-test",
  signal: new AbortController().signal,
};

function createSurface(sendErrors: string[] = []) {
  const sends: { text: string; parse_mode?: string }[] = [];
  // Exercise the pinned adapter's rendering and fallback, replacing only HTTP.
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init: RequestInit) => {
      const method = new URL(input).pathname.split("/").at(-1);
      if (method === "getMe") {
        return Response.json({ ok: true, result: { id: 999, is_bot: true, username: "testbot" } });
      }
      if (method === "sendRichMessage") {
        // Regular Telegram Bot API deployments may not support rich messages.
        return Response.json(
          { ok: false, error_code: 404, description: "Not Found" },
          { status: 404 },
        );
      }
      if (method !== "sendMessage") throw new Error(`Unexpected Telegram method: ${method}`);
      const payload = JSON.parse(String(init.body)) as (typeof sends)[number];
      sends.push(payload);
      const description = sendErrors.shift();
      if (description) {
        const status = description.includes("can't parse") ? 400 : 500;
        return Response.json({ ok: false, error_code: status, description }, { status });
      }
      return Response.json({
        ok: true,
        result: {
          message_id: 42,
          date: 1_700_000_000,
          chat: { id: 123, type: "private" },
          from: { id: 999, is_bot: true, first_name: "Test Bot" },
          text: payload.text,
        },
      });
    }),
  );
  const surface = new ChatSdkMessagingSurface(
    messagingPlatformsFromEnv({
      telegramBotToken: "test-token",
      telegramWebhookSecret: "test-webhook-secret",
    }),
  );
  return { surface, sends, threadId: "telegram:123" };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("Telegram authenticated linking destination", () => {
  it("publishes the token-authenticated identity rather than a configured username", async () => {
    vi.stubEnv("TELEGRAM_BOT_USERNAME", "another_valid_bot");
    const { surface } = createSurface();
    expect(surface.platforms()[0]?.address).toBeUndefined();
    await surface.initialize();
    expect(surface.platforms()[0]?.address).toBe("@testbot");
    await surface.shutdown();
  });

  it("does not advertise a destination when identity lookup fails", async () => {
    vi.stubEnv("TELEGRAM_BOT_USERNAME", "another_valid_bot");
    const { surface } = createSurface();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("identity lookup failed");
      }),
    );
    await surface.initialize();
    expect(surface.platforms()[0]?.address).toBeUndefined();
    await surface.shutdown();
  });

  it("caches verified identities, throttles failures and recovers after expiry", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { surface } = createSurface();
    await surface.initialize();
    expect(surface.platforms()[0]?.address).toBe("@testbot");
    for (let i = 0; i < 3; i++) {
      expect(await surface.resolveAddresses()).toEqual({ telegram: "@testbot" });
    }
    expect(fetch).toHaveBeenCalledOnce();
    vi.setSystemTime(Date.now() + 300_000);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("identity unavailable");
      }),
    );
    expect(await surface.resolveAddresses()).toEqual({});
    expect(surface.platforms()[0]?.address).toBeUndefined();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ ok: true, result: { id: 999, is_bot: true, username: "renamed_testbot" } }),
      ),
    );
    expect(await surface.resolveAddresses()).toEqual({});
    expect(fetch).not.toHaveBeenCalled();
    vi.setSystemTime(Date.now() + 30_000);
    expect(await surface.resolveAddresses()).toEqual({ telegram: "@renamed_testbot" });
    await surface.shutdown();
  });

  it("recovers a startup identity outage when concurrent settings reads request the destination", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { surface } = createSurface();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("startup outage");
      }),
    );
    await surface.initialize();
    expect(surface.platforms()[0]?.address).toBeUndefined();
    vi.setSystemTime(Date.now() + 30_000);
    const lookup = deferred<Response>();
    const fetchMock = vi.fn(async () => lookup.promise);
    vi.stubGlobal("fetch", fetchMock);
    const first = surface.resolveAddresses();
    const second = surface.resolveAddresses();
    lookup.resolve(
      Response.json({ ok: true, result: { id: 999, is_bot: true, username: "testbot" } }),
    );
    expect(await Promise.all([first, second])).toEqual([
      { telegram: "@testbot" },
      { telegram: "@testbot" },
    ]);
    expect(fetchMock).toHaveBeenCalledOnce();
    await surface.shutdown();
  });

  it("cancels only the caller's wait while other readers refresh the shared identity", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { surface } = createSurface();
    await surface.initialize();
    vi.setSystemTime(Date.now() + 300_000);
    const lookup = deferred<Response>();
    const fetchMock = vi.fn(async (_input: string, _init: RequestInit) => lookup.promise);
    vi.stubGlobal("fetch", fetchMock);
    const cancelled = new AbortController();
    const first = surface.resolveAddresses(cancelled.signal);
    const second = surface.resolveAddresses();
    cancelled.abort();
    expect(await first).toEqual({});
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[1].signal?.aborted).toBe(false);
    expect(surface.platforms()[0]?.address).toBe("@testbot");
    lookup.resolve(
      Response.json({ ok: true, result: { id: 999, is_bot: true, username: "renamed_testbot" } }),
    );
    expect(await second).toEqual({ telegram: "@renamed_testbot" });
    expect(await surface.resolveAddresses()).toEqual({ telegram: "@renamed_testbot" });
    expect(fetchMock).toHaveBeenCalledOnce();
    await surface.shutdown();
  });

  it.each([false, true])(
    "does not let a late startup lookup replace or clear a newer identity (failure=%s)",
    async (failure) => {
      const { surface } = createSurface();
      const startup = deferred<Response>();
      const refresh = deferred<Response>();
      const fetchMock = vi
        .fn()
        .mockImplementationOnce(() => startup.promise)
        .mockImplementationOnce(() => refresh.promise);
      vi.stubGlobal("fetch", fetchMock);
      const initializing = surface.initialize();
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
      const resolving = surface.resolveAddresses();
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
      refresh.resolve(
        Response.json({ ok: true, result: { id: 999, is_bot: true, username: "renamed_testbot" } }),
      );
      expect(await resolving).toEqual({ telegram: "@renamed_testbot" });
      if (failure) startup.reject(new TypeError("startup lookup failed"));
      else
        startup.resolve(
          Response.json({
            ok: true,
            result: { id: 999, is_bot: true, username: "previous_testbot" },
          }),
        );
      await initializing;
      expect(surface.platforms()[0]?.address).toBe("@renamed_testbot");
      expect(await surface.resolveAddresses()).toEqual({ telegram: "@renamed_testbot" });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      await surface.shutdown();
    },
  );

  it("keeps a destination hidden when an older lookup succeeds after a newer failure", async () => {
    const { surface } = createSurface();
    const startup = deferred<Response>();
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => startup.promise)
      .mockRejectedValueOnce(new TypeError("newer verification failed"));
    vi.stubGlobal("fetch", fetchMock);
    const initializing = surface.initialize();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(await surface.resolveAddresses()).toEqual({});
    startup.resolve(
      Response.json({
        ok: true,
        result: { id: 999, is_bot: true, username: "previous_testbot" },
      }),
    );
    await initializing;
    expect(surface.platforms()[0]?.address).toBeUndefined();
    expect(await surface.resolveAddresses()).toEqual({});
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await surface.shutdown();
  });

  it("discovers default and named bot destinations independently from their own tokens", async () => {
    vi.stubEnv("TELEGRAM_BOT_USERNAME", "another_valid_bot");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) => {
        const named = new URL(input).pathname.includes("botnamed-token/");
        return Response.json({
          ok: true,
          result: {
            id: named ? 1000 : 999,
            is_bot: true,
            username: named ? "actual_support_bot" : "actual_default_bot",
          },
        });
      }),
    );
    const surface = new ChatSdkMessagingSurface(
      messagingPlatformsFromEnv({
        telegramBotToken: "default-token",
        telegramWebhookSecret: "fake-default-secret",
        telegramBots: [
          { name: "support", botToken: "named-token", webhookSecret: "fake-support-secret" },
        ],
      }),
    );
    expect(surface.platforms().every(({ address }) => address === undefined)).toBe(true);
    await surface.initialize();
    expect(surface.platforms().map(({ provider, address }) => ({ provider, address }))).toEqual([
      { provider: "telegram", address: "@actual_default_bot" },
      { provider: "telegram-support", address: "@actual_support_bot" },
    ]);
    await surface.shutdown();
  });
});

describe("Telegram messaging Markdown", () => {
  it.each([
    ["a".repeat(9000), "a".repeat(9000)],
    [`${"a".repeat(4095)}😀${"b".repeat(4096)}`, `${"a".repeat(4095)}😀${"b".repeat(4096)}`],
    ["!".repeat(4096), "!".repeat(4096)],
    [`**${"!".repeat(4090)}**`, "!".repeat(4090)],
    [`\`\`\`text\n${"\\".repeat(4090)}\n\`\`\``, "\\".repeat(4090)],
  ])("sends every split part without adapter truncation", async (body, expected) => {
    const { surface, sends, threadId } = createSurface();
    const parts = splitOutboundBody("telegram", body);
    for (const part of parts) {
      await surface.sendToThread({ threadId, body: part }, context);
    }

    expect(sends).toHaveLength(parts.length);
    expect(sends.every(({ text }) => text.length <= 4096 && !/[\uD800-\uDFFF]/u.test(text))).toBe(
      true,
    );
    expect(sends.every(({ text }) => !text.includes("…"))).toBe(true);
    // Remove the fixtures' MarkdownV2 wrappers before unescaping literal content.
    const visibleText = sends
      .map(({ text }) =>
        text
          .replace(/^```[^\n]*\n([\s\S]*)\n```$/, "$1")
          .replace(/^\*([^*]*)\*$/s, "$1")
          .replace(/\\([\\!*`])/g, "$1"),
      )
      .join("");
    expect(visibleText).toBe(expected);
  });

  async function sendSplit(body: string): Promise<string[]> {
    const { surface, sends, threadId } = createSurface();
    for (const part of splitOutboundBody("telegram", body)) {
      await surface.sendToThread({ threadId, body: part }, context);
    }
    return sends.map(({ text }) => text);
  }

  it("keeps every link when a long reply is split", async () => {
    const urls = Array.from({ length: 80 }, (_, i) => `https://example.com/articles/${i}`);
    const body = `Sources:\n${urls
      .map((url, i) => `${i + 1}. [Article ${i}](${url}) - a short summary of the article text`)
      .join("\n")}`;
    expect(body.length).toBeGreaterThan(4096);
    const sent = (await sendSplit(body)).join("\n");
    for (const [i, url] of urls.entries()) expect(sent).toContain(`[Article ${i}](${url})`);
  });

  it("keeps link-shaped text in code as written when a long reply is split", async () => {
    const filler = Array.from({ length: 120 }, (_, i) => `Line ${i} of the reply.`).join("\n");
    const sent = await sendSplit(
      `Write links as \`[label](url)\`.\n${filler}\n${"x".repeat(4200)}`,
    );
    expect(sent.length).toBeGreaterThan(1);
    expect(sent[0]).toContain("Write links as `[label](url)`\\.");
  });

  it("keeps a link whose label has brackets when a long reply is split", async () => {
    const sent = await sendSplit(
      `See [the [beta] docs](https://example.com/beta)\n${"x".repeat(4200)}`,
    );
    expect(sent.length).toBeGreaterThan(1);
    expect(sent[0]).toContain("See [the \\[beta\\] docs](https://example.com/beta)");
  });

  it("links a bare address and email once when a long reply is split", async () => {
    const sent = await sendSplit(
      `**Contact** bob@example.com or https://example.com/\n${"x".repeat(4200)}`,
    );
    expect(sent.length).toBeGreaterThan(1);
    expect(sent[0]).toContain(
      "*Contact* [bob@example\\.com](mailto:bob@example.com) or [https://example\\.com/](https://example.com/)",
    );
  });

  it("keeps the address of a link in a reply that fits in one message", () => {
    const body = "Read [the docs](https://example.com/docs/start) first.";
    expect(splitOutboundBody("telegram", body)).toEqual([body]);
  });

  it("keeps every split part in the plain-text fallback after Markdown rejection", async () => {
    const { surface, sends, threadId } = createSurface([
      "Bad Request: can't parse entities",
      "",
      "Bad Request: can't parse entities",
    ]);
    const body = "!".repeat(4096);
    for (const part of splitOutboundBody("telegram", body)) {
      await surface.sendToThread({ threadId, body: part }, context);
    }

    const fallback = sends.filter((send) => !send.parse_mode);
    expect(fallback).toHaveLength(2);
    expect(fallback.map(({ text }) => text).join("")).toBe(body);
    expect(sends.every(({ text }) => text.length <= 4096)).toBe(true);
  });

  it("renders headings, bold, links and escaped punctuation as MarkdownV2", async () => {
    const { surface, sends, threadId } = createSurface();
    const result = await surface.sendToThread(
      {
        threadId,
        body: "# Heading\n\n**bold** and [link](https://example.test)\n\nHello_world! (test).",
      },
      context,
    );

    expect(result.handle).toBeTruthy();
    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatchObject({
      parse_mode: "MarkdownV2",
      text: "*Heading*\n\n*bold* and [link](https://example.test)\n\nHello\\_world\\! \\(test\\)\\.",
    });
  });

  it("retries a Markdown parse rejection as plain text and returns its handle", async () => {
    const { surface, sends, threadId } = createSurface([
      "Bad Request: can't parse entities: Can't find end of Bold entity",
    ]);

    const result = await surface.sendToThread({ threadId, body: "**bold**!" }, context);

    expect(result.handle).toBeTruthy();
    expect(sends).toHaveLength(2);
    expect(sends[0]).toMatchObject({ parse_mode: "MarkdownV2", text: "*bold*\\!" });
    expect(sends[1]).toMatchObject({ text: "bold!" });
    expect(sends[1]).not.toHaveProperty("parse_mode");
  });

  it("keeps a link's address when a reply is sent as plain text", async () => {
    const { surface, sends, threadId } = createSurface(["Bad Request: can't parse entities"]);

    await surface.sendToThread(
      {
        threadId,
        body: "Read [the docs](https://example.com/docs) or https://example.com/faq. ![A chart](https://example.com/chart.png)",
      },
      context,
    );

    expect(sends[1]).toEqual({
      chat_id: "123",
      text: "Read the docs (https://example.com/docs) or https://example.com/faq. A chart (https://example.com/chart.png)",
    });
  });

  it("keeps every part of a long reply within one message when sent as plain text", async () => {
    const rows = Array.from(
      { length: 90 },
      (_, row) => `- [Article ${row}](https://example.com/articles/${row}/${"path/".repeat(8)})`,
    );
    const parts = splitOutboundBody("telegram", rows.join("\n"));
    const { surface, sends, threadId } = createSurface(
      parts.flatMap(() => ["Bad Request: can't parse entities", ""]),
    );
    for (const part of parts) await surface.sendToThread({ threadId, body: part }, context);

    const fallback = sends.filter((send) => !send.parse_mode).map(({ text }) => text);
    expect(fallback).toHaveLength(parts.length);
    expect(fallback.every((text) => text.length <= 4096 && !text.includes("…"))).toBe(true);
    for (const [row] of rows.entries()) {
      expect(fallback.join("\n")).toContain(`Article ${row} (https://example.com/articles/${row}/`);
    }
  });

  it("propagates unrelated send failures without a duplicate plain-text attempt", async () => {
    const { surface, sends, threadId } = createSurface(["Internal Server Error"]);

    await expect(surface.sendToThread({ threadId, body: "**bold**" }, context)).rejects.toThrow(
      "Internal Server Error",
    );
    expect(sends).toHaveLength(1);
  });

  it("propagates a failed plain-text fallback for upstream delivery recovery", async () => {
    const { surface, sends, threadId } = createSurface([
      "Bad Request: can't parse entities",
      "Internal Server Error",
    ]);

    await expect(surface.sendToThread({ threadId, body: "**bold**" }, context)).rejects.toThrow(
      "Internal Server Error",
    );
    expect(sends).toHaveLength(2);
    expect(sends[1]).not.toHaveProperty("parse_mode");
  });
});

describe("Telegram bots side by side", () => {
  const telegramUpdate = (text: string) => ({
    update_id: 1,
    message: {
      message_id: 7,
      date: 1_700_000_000,
      chat: { id: 123, type: "private", first_name: "Ada" },
      from: { id: 123, is_bot: false, first_name: "Ada" },
      text,
    },
  });

  function createTwoBotSurface() {
    const sends: { token: string; chatId: unknown }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string, init: RequestInit) => {
        const url = new URL(input);
        const [, botPath, method] = url.pathname.split("/");
        const token = botPath!.replace(/^bot/, "");
        if (method === "getMe") {
          return Response.json({ ok: true, result: { id: 9, is_bot: true, username: token } });
        }
        if (method === "sendRichMessage") {
          return Response.json(
            { ok: false, error_code: 404, description: "Not Found" },
            {
              status: 404,
            },
          );
        }
        if (method !== "sendMessage") throw new Error(`Unexpected Telegram method: ${method}`);
        const payload = JSON.parse(String(init.body)) as { chat_id: unknown; text: string };
        sends.push({ token, chatId: payload.chat_id });
        return Response.json({
          ok: true,
          result: {
            message_id: 42,
            date: 1_700_000_000,
            chat: { id: 123, type: "private" },
            from: { id: 9, is_bot: true, first_name: token },
            text: payload.text,
          },
        });
      }),
    );
    const telegram = (botToken: string, secretToken: string) =>
      createTelegramAdapter({ botToken, secretToken, mode: "webhook" });
    const capabilities = { direct: true, groups: false, receipt: null };
    const surface = new ChatSdkMessagingSurface([
      { provider: "telegram", capabilities, adapter: telegram("home-token", "home-secret") },
      {
        provider: "telegram-work",
        adapterName: "telegram",
        capabilities,
        adapter: telegram("work-token", "work-secret"),
      },
    ]);
    const inbound: MessagingInboundEvent[] = [];
    surface.onInbound(async (event) => {
      inbound.push(event);
    });
    return { surface, sends, inbound };
  }

  const webhook = (secret: string, text: string) =>
    new Request("https://rakazo.test/api/v1/messaging/webhook/x", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": secret,
      },
      body: JSON.stringify(telegramUpdate(text)),
    });

  it("keeps the same Telegram user's chats with each bot apart, inbound and outbound", async () => {
    const { surface, sends, inbound } = createTwoBotSurface();

    expect(
      (await surface.handleWebhook("telegram", webhook("home-secret", "hi home")))?.status,
    ).toBe(200);
    expect(
      (await surface.handleWebhook("telegram-work", webhook("work-secret", "hi work")))?.status,
    ).toBe(200);
    expect(inbound).toMatchObject([
      { provider: "telegram", threadId: "telegram:123", from: "123", content: "hi home" },
      { provider: "telegram-work", threadId: "telegram-work:123", from: "123", content: "hi work" },
    ]);

    await surface.sendToThread({ threadId: "telegram-work:123", body: "from work" }, context);
    await surface.sendToThread({ threadId: "telegram:123", body: "from home" }, context);
    expect(sends).toEqual([
      { token: "work-token", chatId: "123" },
      { token: "home-token", chatId: "123" },
    ]);
    expect(await surface.openDirectThread("telegram-work", "123", context)).toBe(
      "telegram-work:123",
    );
  });

  it("refuses a webhook with no shared-secret header", async () => {
    const { surface, inbound } = createTwoBotSurface();
    const request = webhook("home-secret", "forged");
    request.headers.delete("x-telegram-bot-api-secret-token");
    expect((await surface.handleWebhook("telegram", request))?.status).toBe(401);
    expect(inbound).toEqual([]);
  });

  it("acknowledges a repeated webhook without delivering it twice", async () => {
    const { surface, inbound } = createTwoBotSurface();
    expect((await surface.handleWebhook("telegram", webhook("home-secret", "hello")))?.status).toBe(
      200,
    );
    expect((await surface.handleWebhook("telegram", webhook("home-secret", "hello")))?.status).toBe(
      200,
    );
    expect(inbound).toHaveLength(1);
  });

  it("rejects an update signed with another bot's webhook secret", async () => {
    const { surface, inbound } = createTwoBotSurface();

    const response = await surface.handleWebhook("telegram-work", webhook("home-secret", "x"));

    expect(response?.status).toBe(401);
    expect(inbound).toEqual([]);
  });
});

describe("Telegram groups", () => {
  function createGroupSurface(env: Partial<MessagingEnvironmentValues> = {}) {
    const sends: { token: string; payload: Record<string, unknown> }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string, init: RequestInit) => {
        const url = new URL(input);
        const [, botPath, method] = url.pathname.split("/");
        const token = botPath!.replace(/^bot/, "");
        if (method === "getMe") {
          const work = token.includes("work");
          return Response.json({
            ok: true,
            result: {
              id: work ? 998 : 999,
              is_bot: true,
              username: work ? "workbot" : "testbot",
            },
          });
        }
        if (method === "sendChatAction") return Response.json({ ok: true, result: true });
        if (method === "sendRichMessage") {
          return Response.json(
            { ok: false, error_code: 404, description: "Not Found" },
            { status: 404 },
          );
        }
        if (method !== "sendMessage") throw new Error(`Unexpected Telegram method: ${method}`);
        const payload = JSON.parse(String(init.body)) as Record<string, unknown>;
        sends.push({ token, payload });
        return Response.json({
          ok: true,
          result: {
            message_id: 42,
            date: 1_700_000_000,
            chat: { id: payload.chat_id, type: "supergroup" },
            from: { id: 999, is_bot: true, first_name: "Test Bot" },
            text: payload.text,
          },
        });
      }),
    );
    // Mount the production platform entries, not hand-built ones, so the
    // capability and hook wiring itself is under test.
    const surface = new ChatSdkMessagingSurface(
      messagingPlatformsFromEnv({
        telegramBotToken: "home-token",
        telegramWebhookSecret: "home-secret",
        telegramBots: [{ name: "work", botToken: "work-token", webhookSecret: "work-secret" }],
        ...env,
      }),
    );
    const inbound: MessagingInboundEvent[] = [];
    surface.onInbound(async (event) => {
      inbound.push(event);
    });
    return { surface, sends, inbound };
  }

  const webhook = (secret: string, update: unknown) =>
    new Request("https://rakazo.test/api/v1/messaging/webhook/x", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": secret,
      },
      body: JSON.stringify(update),
    });

  const familyChat = { id: -1001234, type: "supergroup" as const, title: "Family" };
  const sender = { id: 777, is_bot: false, first_name: "Grace" };

  function groupMessage(messageOverrides: Record<string, unknown> = {}, updateId = 101) {
    return {
      update_id: updateId,
      message: {
        message_id: 11,
        date: 1_700_000_000,
        chat: familyChat,
        from: sender,
        text: "hello group",
        ...messageOverrides,
      },
    };
  }

  it("delivers a group message with the chat title and the mention flag", async () => {
    const { surface, inbound } = createGroupSurface();

    expect(
      (
        await surface.handleWebhook(
          "telegram",
          webhook(
            "home-secret",
            groupMessage({
              message_id: 11,
              text: "@testbot hello",
              entities: [{ type: "mention", offset: 0, length: 8 }],
            }),
          ),
        )
      )?.status,
    ).toBe(200);
    expect(
      (
        await surface.handleWebhook(
          "telegram",
          webhook("home-secret", groupMessage({ message_id: 12 }, 102)),
        )
      )?.status,
    ).toBe(200);

    expect(inbound).toHaveLength(2);
    expect(inbound[0]).toMatchObject({
      type: "message",
      provider: "telegram",
      handle: "-1001234:11",
      threadId: "telegram:-1001234",
      isDirect: false,
      from: "777",
      fromLabel: "Grace",
      channelName: "Family",
      participants: [],
      content: "@testbot hello",
      mentionsBot: true,
    });
    expect(inbound[1]).toMatchObject({
      threadId: "telegram:-1001234",
      content: "hello group",
    });
    expect(inbound[1]?.type === "message" && inbound[1].mentionsBot).toBeUndefined();
  });

  it("ignores group chats on every bot when groups are turned off, and still takes direct chats", async () => {
    const { surface, inbound } = createGroupSurface({ telegramGroups: "OFF" });

    expect(
      surface.platforms().map(({ provider, capabilities }) => [provider, capabilities]),
    ).toEqual([
      ["telegram", expect.objectContaining({ direct: true, groups: false })],
      ["telegram-work", expect.objectContaining({ direct: true, groups: false })],
    ]);
    for (const [provider, secret, updateId] of [
      ["telegram", "home-secret", 105],
      ["telegram-work", "work-secret", 106],
    ] as const) {
      const response = await surface.handleWebhook(
        provider,
        webhook(secret, groupMessage({ text: "@testbot hello" }, updateId)),
      );
      expect(response?.status).toBe(200);
    }
    expect(inbound).toEqual([]);

    await surface.handleWebhook(
      "telegram",
      webhook("home-secret", {
        update_id: 107,
        message: {
          message_id: 16,
          date: 1_700_000_000,
          chat: { id: 777, type: "private", first_name: "Grace" },
          from: sender,
          text: "hello direct",
        },
      }),
    );
    expect(inbound).toEqual([
      expect.objectContaining({
        threadId: "telegram:777",
        isDirect: true,
        content: "hello direct",
      }),
    ]);
  });

  it("keeps group chats on by default and for on, true and 1", () => {
    for (const telegramGroups of [undefined, "", "on", " TRUE ", "1"]) {
      const { surface } = createGroupSurface({ telegramGroups });
      expect(surface.platforms().every(({ capabilities }) => capabilities.groups)).toBe(true);
    }
  });

  it("turns group chats off for off, false and 0 in any case", () => {
    for (const telegramGroups of ["off", "OFF", " False ", "0"]) {
      const { surface } = createGroupSurface({ telegramGroups });
      expect(surface.platforms().map(({ capabilities }) => capabilities.groups)).toEqual([
        false,
        false,
      ]);
    }
  });

  it("refuses a TELEGRAM_GROUPS value it cannot read, instead of leaving groups on", () => {
    for (const telegramGroups of ["no", "disabled", "flase"]) {
      expect(() => createGroupSurface({ telegramGroups })).toThrow(
        "TELEGRAM_GROUPS must be on or off",
      );
    }
  });

  it("keeps a plain reply on the group's own thread", async () => {
    const { surface, inbound } = createGroupSurface();

    expect(
      (
        await surface.handleWebhook(
          "telegram",
          webhook(
            "home-secret",
            groupMessage({
              message_id: 13,
              message_thread_id: 9,
              text: "yes please",
              reply_to_message: {
                message_id: 9,
                date: 1_700_000_000,
                chat: familyChat,
                from: { id: 999, is_bot: true, first_name: "Test Bot" },
                text: "earlier bot reply",
              },
            }),
          ),
        )
      )?.status,
    ).toBe(200);

    expect(inbound).toEqual([
      expect.objectContaining({
        threadId: "telegram:-1001234",
        content: "yes please",
      }),
    ]);
  });

  it("keeps a forum topic as its own conversation", async () => {
    const { surface, inbound } = createGroupSurface();

    await surface.handleWebhook(
      "telegram",
      webhook(
        "home-secret",
        groupMessage({ message_id: 14, is_topic_message: true, message_thread_id: 12 }),
      ),
    );

    expect(inbound).toEqual([
      expect.objectContaining({ threadId: "telegram:-1001234:12", channelName: "Family" }),
    ]);
  });

  it("ignores broadcast channel posts", async () => {
    const { surface, inbound } = createGroupSurface();

    const response = await surface.handleWebhook(
      "telegram",
      webhook("home-secret", {
        update_id: 104,
        channel_post: {
          message_id: 21,
          date: 1_700_000_000,
          chat: { id: -1005499, type: "channel", title: "Announcements" },
          text: "big news",
        },
      }),
    );

    expect(response?.status).toBe(200);
    expect(inbound).toEqual([]);
  });

  it("keeps each bot's group threads apart and posts replies to the right chat", async () => {
    const { surface, sends, inbound } = createGroupSurface();

    await surface.handleWebhook(
      "telegram-work",
      webhook("work-secret", groupMessage({ message_id: 15, text: "hi work bot" })),
    );
    expect(inbound).toMatchObject([
      {
        provider: "telegram-work",
        threadId: "telegram-work:-1001234",
        channelName: "Family",
      },
    ]);

    await surface.sendToThread({ threadId: "telegram-work:-1001234", body: "from work" }, context);
    await surface.sendToThread({ threadId: "telegram:-1001234", body: "from home" }, context);
    expect(sends.map(({ token, payload }) => [token, payload.chat_id])).toEqual([
      ["work-token", "-1001234"],
      ["home-token", "-1001234"],
    ]);
  });

  it("posts a forum topic reply into its topic", async () => {
    const { surface, sends } = createGroupSurface();

    await surface.sendToThread({ threadId: "telegram:-1001234:12", body: "topic reply" }, context);

    expect(sends[0]?.payload).toMatchObject({ chat_id: "-1001234", message_thread_id: 12 });
  });

  it("reports a member who left or was removed as a departure, not a message", async () => {
    const { surface, inbound } = createGroupSurface();

    expect(
      (
        await surface.handleWebhook(
          "telegram",
          webhook(
            "home-secret",
            groupMessage({
              message_id: 16,
              text: undefined,
              left_chat_member: { id: 888, is_bot: false, first_name: "Heather" },
            }),
          ),
        )
      )?.status,
    ).toBe(200);

    expect(inbound).toEqual([
      expect.objectContaining({
        type: "message",
        threadId: "telegram:-1001234",
        isDirect: false,
        from: "777",
        content: "",
        departures: { addresses: ["888"], botLeft: false },
      }),
    ]);
  });

  it("flags the bot's own removal as the channel's end", async () => {
    const { surface, inbound } = createGroupSurface();

    expect(
      (
        await surface.handleWebhook(
          "telegram",
          webhook(
            "home-secret",
            groupMessage({
              message_id: 17,
              text: undefined,
              from: { id: 600, is_bot: false, first_name: "Ada" },
              // The home bot's getMe id is 999.
              left_chat_member: { id: 999, is_bot: true, username: "testbot" },
            }),
          ),
        )
      )?.status,
    ).toBe(200);

    expect(inbound).toEqual([
      expect.objectContaining({ departures: { addresses: [], botLeft: true } }),
    ]);
  });
});

describe("Telegram messaging files", () => {
  function createFileSurface() {
    const uploads: { method: string; field: string; filename: string; caption: unknown }[] = [];
    // Exercise the pinned adapter's upload requests, replacing only HTTP.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string, init: RequestInit) => {
        const method = new URL(input).pathname.split("/").at(-1)!;
        if (method === "getMe") {
          return Response.json({
            ok: true,
            result: { id: 999, is_bot: true, username: "testbot" },
          });
        }
        if (method !== "sendPhoto" && method !== "sendDocument") {
          throw new Error(`Unexpected Telegram method: ${method}`);
        }
        const form = init.body as FormData;
        const field = method === "sendPhoto" ? "photo" : "document";
        const file = form.get(field) as File;
        uploads.push({ method, field, filename: file.name, caption: form.get("caption") });
        return Response.json({
          ok: true,
          result: {
            message_id: 43,
            date: 1_700_000_000,
            chat: { id: 123, type: "private" },
            from: { id: 999, is_bot: true, first_name: "Test Bot" },
          },
        });
      }),
    );
    const adapter = createTelegramAdapter({
      botToken: "test-token",
      secretToken: "test-webhook-secret",
      mode: "webhook",
    });
    const surface = new ChatSdkMessagingSurface([
      {
        provider: "telegram",
        capabilities: { direct: true, groups: false, receipt: null, files: true },
        adapter,
      },
    ]);
    return { surface, uploads, threadId: adapter.encodeThreadId({ chatId: "123" }) };
  }

  it("sends an image as a photo and other files as documents", async () => {
    const { surface, uploads, threadId } = createFileSurface();
    const data = new Uint8Array([1, 2, 3]);

    const photo = await surface.sendToThread(
      { threadId, body: "", attachment: { name: "chart.png", mimeType: "image/png", data } },
      context,
    );
    await surface.sendToThread(
      { threadId, body: "", attachment: { name: "report.pdf", mimeType: "application/pdf", data } },
      context,
    );

    expect(photo.handle).toBeTruthy();
    expect(uploads).toEqual([
      { method: "sendPhoto", field: "photo", filename: "chart.png", caption: null },
      { method: "sendDocument", field: "document", filename: "report.pdf", caption: null },
    ]);
  });
});

describe("Telegram redelivery", () => {
  it.each([
    [
      "telegram",
      999,
      5,
      { telegramBotToken: "test-token", telegramWebhookSecret: "test-webhook-secret" },
    ],
    [
      "telegram-work",
      1001,
      6,
      {
        telegramBots: [
          { name: "work", botToken: "test-token", webhookSecret: "test-webhook-secret" },
        ],
      },
    ],
  ] as [string, number, number, MessagingEnvironmentValues][])(
    "processes Telegram's retry of an update the sink failed on, exactly once (%s)",
    async (provider, botId, updateId, env) => {
      // The pinned adapter claims each update id; only getMe goes over HTTP.
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          Response.json({ ok: true, result: { id: botId, is_bot: true, username: "testbot" } }),
        ),
      );
      const surface = new ChatSdkMessagingSurface(messagingPlatformsFromEnv(env));
      const inbound: string[] = [];
      surface.onInbound(async (event) => {
        if (event.type !== "message") return;
        inbound.push(event.content);
        if (inbound.length === 1) throw new Error("database unavailable");
      });
      const update = () =>
        new Request("https://rakazo.test/api/v1/messaging/webhook/telegram", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-telegram-bot-api-secret-token": "test-webhook-secret",
          },
          body: JSON.stringify({
            update_id: updateId,
            message: {
              message_id: 7,
              date: 1_700_000_000,
              chat: { id: 123, type: "private", first_name: "Ada" },
              from: { id: 123, is_bot: false, first_name: "Ada" },
              text: "remind me at 5",
            },
          }),
        });

      const statuses = [];
      for (let attempt = 0; attempt < 3; attempt += 1) {
        statuses.push((await surface.handleWebhook(provider, update()))?.status);
      }

      expect(statuses).toEqual([500, 200, 200]);
      expect(inbound).toEqual(["remind me at 5", "remind me at 5"]);
    },
  );
});
