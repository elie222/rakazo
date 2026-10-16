import { createTelegramAdapter } from "@chat-adapter/telegram";
import type { AdapterContext } from "@rakazo/adapter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatSdkMessagingSurface } from "./chat-sdk-surface.js";

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
    { provider: "telegram", capabilities: { direct: true, groups: false, typing: false }, adapter },
  ]);
  return { surface, sends, threadId: adapter.encodeThreadId({ chatId: "123" }) };
}

afterEach(() => vi.unstubAllGlobals());

describe("Telegram messaging Markdown", () => {
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
