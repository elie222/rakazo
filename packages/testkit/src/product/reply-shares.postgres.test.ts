import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { createApp } from "@rakazo/api/app";
import type { ReplyShareSummary } from "@rakazo/contracts";
import { SHARED_REPLY_PATH_PREFIX } from "@rakazo/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BotIntroHarness } from "../discard-bot-intro.js";
import { discardBotIntroFromCreate } from "../discard-bot-intro.js";
import { sessionCookieHeader } from "../index.js";
import { asSystem } from "../system-db.js";

type App = { request: (input: string, init?: RequestInit) => Response | Promise<Response> };

process.env.WAKEUP_DRIVER = "memory";
process.env.SANDBOX_PROVIDER = "fake";
process.env.AGENT_RUNTIME = "scripted";

const hasDb = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
let harness: BotIntroHarness | undefined;

const HIDDEN = "CANARY-HIDDEN-7f3a";

describe.skipIf(!hasDb)("shared bot replies", () => {
  let app: App;
  let stop: () => Promise<void>;
  let handles: Awaited<ReturnType<typeof createApp>>;
  const stamp = Date.now();
  let seq = 1000;

  beforeAll(async () => {
    const { createApp } = await import("@rakazo/api/app");
    handles = await createApp({
      databaseUrl: process.env.DATABASE_URL!,
      dataDir: mkdtempSync(path.join(tmpdir(), "rakazo-reply-shares-")),
      sandboxProvider: "fake",
      agentRuntime: "scripted",
    });
    app = handles.app;
    stop = handles.stop;
    harness = handles;
  });

  afterAll(async () => {
    await stop?.();
  });

  const db = () => asSystem(handles.prisma);

  async function botWithReply(cookie: string, name: string, role = "bot") {
    const bot = await rpc<{ id: string }>(app, cookie, "bots/create", { name });
    const thread = await db().thread.findFirstOrThrow({ where: { botId: bot.id } });
    const message = await db().message.create({
      data: {
        threadId: thread.id,
        seq: seq++,
        role,
        botId: bot.id,
        blocks: [
          { kind: "text", text: "  The answer is 42. Mail owner@example.com for more.  " },
          { kind: "steps", steps: [{ label: "Searched", count: 1, note: HIDDEN }] },
          { kind: "card", lines: [{ k: "secret", v: HIDDEN }] },
          { kind: "meta", text: HIDDEN },
          { kind: "text", text: "Second paragraph." },
        ],
      },
    });
    return { botId: bot.id, threadId: thread.id, messageId: message.id };
  }

  const tokenOf = (shareUrl: string) => new URL(shareUrl).pathname.split("/").pop()!;
  const read = (token: string) => app.request(`${SHARED_REPLY_PATH_PREFIX}${token}`);

  it("shows only the reply's redacted text, signed out, until the sharer removes it", async () => {
    const owner = await signup(app, `reply-owner-${stamp}@example.test`, "Owner");
    const other = await signup(app, `reply-other-${stamp}@example.test`, "Other");
    const reply = await botWithReply(owner, "Answer bot");
    const { shareUrl } = await rpc<{ shareUrl: string }>(app, owner, "replyShares/create", {
      botId: reply.botId,
      messageId: reply.messageId,
    });
    expect(new URL(shareUrl).pathname).toMatch(/^\/c\/[A-Za-z0-9_-]{43}$/);
    const token = tokenOf(shareUrl);
    // Only the token's hash is stored.
    const row = await db().replyShare.findFirstOrThrow({ where: { messageId: reply.messageId } });
    expect(row.tokenHash).not.toContain(token);

    const response = await read(token);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("x-robots-tag")).toContain("noindex");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    const bytes = await response.text();
    expect(bytes).not.toContain(HIDDEN);
    expect(bytes).not.toContain("owner@example.com");
    expect(JSON.parse(bytes)).toEqual({
      botName: "Answer bot",
      text: "The answer is 42. Mail [Redacted] for more.\n\nSecond paragraph.",
      sharedAt: row.createdAt.toISOString(),
    });

    const list = await rpc<ReplyShareSummary[]>(app, owner, "replyShares/list");
    expect(list).toEqual([
      {
        id: row.id,
        botName: "Answer bot",
        preview: expect.stringMatching(/^The answer is 42\./),
        createdAt: row.createdAt.toISOString(),
      },
    ]);
    expect(await rpc(app, other, "replyShares/list")).toEqual([]);

    // Only the sharer removes it.
    await rpc(app, other, "replyShares/remove", { shareId: row.id });
    expect((await read(token)).status).toBe(200);
    await rpc(app, owner, "replyShares/remove", { shareId: row.id });
    const gone = await read(token);
    expect(gone.status).toBe(404);
    expect(gone.headers.get("cache-control")).toContain("no-store");
    const missing = await read("A".repeat(43));
    expect([missing.status, await missing.text()]).toEqual([404, await gone.text()]);
  });

  it("refuses people's messages and chats the caller cannot open", async () => {
    const owner = await signup(app, `reply-refuse-${stamp}@example.test`, "Owner");
    const outsider = await signup(app, `reply-outsider-${stamp}@example.test`, "Outsider");
    const mine = await botWithReply(owner, "Mine", "user");
    const theirs = await botWithReply(owner, "Theirs");
    const shared = (cookie: string, target: { botId: string; messageId: string }) =>
      raw(app, cookie, "replyShares/create", target);
    expect((await shared(owner, mine)).status).toBe(400);
    expect((await shared(outsider, theirs)).status).toBe(404);
    // A reply from another chat of the caller's is not found in this one.
    expect((await shared(owner, { botId: mine.botId, messageId: theirs.messageId })).status).toBe(
      404,
    );
    expect(
      await db().replyShare.count({ where: { botId: { in: [mine.botId, theirs.botId] } } }),
    ).toBe(0);
  });

  it("ends the link when the chat is cleared, the bot deleted, or the sharer leaves", async () => {
    const owner = await signup(app, `reply-ends-${stamp}@example.test`, "Owner");
    const share = async (name: string) => {
      const reply = await botWithReply(owner, name);
      const { shareUrl } = await rpc<{ shareUrl: string }>(app, owner, "replyShares/create", {
        botId: reply.botId,
        messageId: reply.messageId,
      });
      const token = tokenOf(shareUrl);
      expect((await read(token)).status).toBe(200);
      return { ...reply, token };
    };

    const cleared = await share("Cleared");
    await rpc(app, owner, "threads/clear", { botId: cleared.botId });
    expect((await read(cleared.token)).status).toBe(404);

    const deletedMessage = await share("Deleted message");
    await db().message.delete({ where: { id: deletedMessage.messageId } });
    expect((await read(deletedMessage.token)).status).toBe(404);

    const removedBot = await share("Removed bot");
    await rpc(app, owner, "bots/remove", { botId: removedBot.botId });
    expect((await read(removedBot.token)).status).toBe(404);

    const left = await share("Left");
    const row = await db().replyShare.findFirstOrThrow({ where: { messageId: left.messageId } });
    await db().spaceMember.delete({
      where: { spaceId_userId: { spaceId: row.spaceId, userId: row.userId } },
    });
    expect((await read(left.token)).status).toBe(404);
  });

  it("leaves no link when the reply is deleted while one is made", async () => {
    const owner = await signup(app, `reply-race-${stamp}@example.test`, "Owner");
    const reply = await botWithReply(owner, "Racing");
    // The checked fields never change, so only the delete can interleave; the cascade or the
    // foreign key ends the link either way.
    const [created] = await Promise.all([
      raw(app, owner, "replyShares/create", { botId: reply.botId, messageId: reply.messageId }),
      db().message.delete({ where: { id: reply.messageId } }),
    ]);
    expect([200, 404]).toContain(created.status);
    expect(await db().replyShare.count({ where: { messageId: reply.messageId } })).toBe(0);
    if (created.status === 200) {
      const { json } = (await created.json()) as { json: { shareUrl: string } };
      expect((await read(tokenOf(json.shareUrl))).status).toBe(404);
    }
  });

  it("ends the link when the sharer deletes their account", async () => {
    const owner = await signup(app, `reply-account-${stamp}@example.test`, "Owner");
    const reply = await botWithReply(owner, "Account");
    const { shareUrl } = await rpc<{ shareUrl: string }>(app, owner, "replyShares/create", {
      botId: reply.botId,
      messageId: reply.messageId,
    });
    const token = tokenOf(shareUrl);
    const deleted = await app.request("/api/auth/delete-user", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: owner,
        origin: "http://127.0.0.1:5173",
      },
      body: JSON.stringify({ password: "test-password-123" }),
    });
    expect(deleted.status).toBe(200);
    expect((await read(token)).status).toBe(404);
  });
});

async function signup(app: App, email: string, name: string) {
  const response = await app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://127.0.0.1:5173" },
    body: JSON.stringify({ email, password: "test-password-123", name }),
  });
  expect(response.status).toBeLessThan(400);
  return sessionCookieHeader(response);
}

async function rpc<T>(app: App, cookie: string, proc: string, body: unknown = {}): Promise<T> {
  const res = await raw(app, cookie, proc, body);
  const text = await res.text();
  const parsed = JSON.parse(text) as { json?: T; error?: { message?: string } };
  if (res.status >= 400 || parsed.error) {
    throw new Error(`${proc} ${res.status}: ${parsed.error?.message ?? text}`);
  }
  return discardBotIntroFromCreate(harness, cookie, proc, parsed.json as T);
}

async function raw(app: App, cookie: string, proc: string, body: unknown) {
  return app.request(`/rpc/${proc}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, origin: "http://127.0.0.1:5173" },
    body: JSON.stringify({ json: body }),
  });
}
