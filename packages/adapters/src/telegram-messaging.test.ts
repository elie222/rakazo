import { createTelegramAdapter } from "@chat-adapter/telegram";
import type { AdapterContext, MessagingInboundEvent } from "@rakazo/adapter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatSdkMessagingSurface } from "./chat-sdk-surface.js";
import { splitOutboundBody } from "./messaging-platforms.js";

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
  const adapter = createTelegramAdapter({
    botToken: "test-token",
    secretToken: "test-webhook-secret",
    mode: "webhook",
  });
  const surface = new ChatSdkMessagingSurface([
    { provider: "telegram", capabilities: { direct: true, groups: false, receipt: null }, adapter },
  ]);
  return { surface, sends, threadId: adapter.encodeThreadId({ chatId: "123" }) };
}

afterEach(() => vi.unstubAllGlobals());

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

  it("rejects an update signed with another bot's webhook secret", async () => {
    const { surface, inbound } = createTwoBotSurface();

    const response = await surface.handleWebhook("telegram-work", webhook("home-secret", "x"));

    expect(response?.status).toBe(401);
    expect(inbound).toEqual([]);
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
