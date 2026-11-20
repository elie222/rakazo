import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ThreadSnapshot, TopicSummary } from "@rakazo/contracts";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { BotIntroHarness } from "../discard-bot-intro.js";
import { discardBotIntroFromCreate } from "../discard-bot-intro.js";
import { sessionCookieHeader } from "../index.js";

type App = { request: (input: string, init?: RequestInit) => Response | Promise<Response> };
type Target = { botId: string; topicId?: string };

process.env.WAKEUP_DRIVER = "memory";
process.env.SANDBOX_PROVIDER = "fake";
process.env.AGENT_RUNTIME = "scripted";

const hasDb = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const describeTopics = hasDb ? describe : describe.skip;
let botIntroHarness: BotIntroHarness | undefined;

describeTopics("threads under bot messages", () => {
  let app: App;
  let stop: () => Promise<void>;
  const stamp = Date.now();
  const dataDir = mkdtempSync(path.join(tmpdir(), "rakazo-topics-"));

  beforeAll(async () => {
    const { createApp } = await import("@rakazo/api/app");
    const handles = await createApp({
      databaseUrl: process.env.DATABASE_URL!,
      dataDir,
      sandboxProvider: "fake",
      agentRuntime: "scripted",
    });
    app = handles.app;
    stop = handles.stop;
    botIntroHarness = handles;
  });

  afterAll(async () => {
    await stop?.();
  });

  const text = (snap: ThreadSnapshot) => JSON.stringify(snap.messages);

  it("a posted item opens its own thread, whose replies stay out of the chat until it is done", async () => {
    const cookie = await signup(app, `topics-${stamp}@rakazo.test`, "Topics");
    const bot = await rpc<{ id: string }>(app, cookie, "bots/create", {
      name: "Inbox",
      title: "Inbox",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    const chat = { botId: bot.id };
    await sendAndWait(app, cookie, chat, "post an item: **#412 Crash on launch** on iPad mini");
    const topics = async () =>
      (await rpc<{ topics: TopicSummary[] }>(app, cookie, "threads/topics", chat)).topics;
    const [item] = await topics();
    expect(item).toMatchObject({
      title: "#412 Crash on launch on iPad mini",
      item: true,
      replyCount: 0,
      unread: true,
      settledBy: null,
    });
    const thread = { ...chat, topicId: item!.id };
    const opened = await rpc<ThreadSnapshot>(app, cookie, "threads/get", thread);
    expect(opened.topicRoot?.id).toBe(item!.rootMessageId);
    expect(opened.messages).toHaveLength(0);

    await sendAndWait(app, cookie, thread, "Is this the same as last week's crash?");
    const replied = await rpc<ThreadSnapshot>(app, cookie, "threads/get", thread);
    expect(text(replied)).toContain("same as last week");
    expect(replied.messages.length).toBeGreaterThanOrEqual(2);
    expect(text(await rpc<ThreadSnapshot>(app, cookie, "threads/get", chat))).not.toContain(
      "same as last week",
    );
    expect((await topics())[0]).toMatchObject({ id: item!.id, settledBy: null });

    await sendAndWait(app, cookie, thread, "Thanks, settle this thread.");
    expect((await topics())[0]?.settledBy).toBe("bot");
    await rpc(app, cookie, "threads/settleTopic", { ...thread, done: false });
    expect((await topics())[0]?.settledBy).toBeNull();
    await rpc(app, cookie, "threads/settleTopic", { ...thread, done: true });
    expect((await topics())[0]?.settledBy).toBe("user");

    // Opening a reply on any message in the chat gives the same thread each time.
    const root = item!.rootMessageId;
    const { topicId } = await rpc<{ topicId: string }>(app, cookie, "threads/openTopic", {
      ...chat,
      messageId: root,
    });
    expect(topicId).toBe(item!.id);

    // Someone else's bot cannot reach the thread, even naming it directly.
    const stranger = await signup(app, `topics-stranger-${stamp}@rakazo.test`, "Stranger");
    const own = await rpc<{ id: string }>(app, stranger, "bots/create", {
      name: "Mine",
      title: "Mine",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    await expect(
      rpc(app, stranger, "threads/get", { botId: own.id, topicId: item!.id }),
    ).rejects.toThrow();
    await expect(
      rpc(app, stranger, "threads/openTopic", { botId: own.id, messageId: root }),
    ).rejects.toThrow();
  });
});

async function sendAndWait(app: App, cookie: string, target: Target, text: string) {
  await rpc(app, cookie, "threads/send", { ...target, text });
  await vi.waitFor(
    async () => {
      const snap = await rpc<ThreadSnapshot>(app, cookie, "threads/get", target);
      if (snap.run && !["completed", "failed", "cancelled"].includes(snap.run.status))
        throw new Error(`timeout waiting for the run: ${JSON.stringify(snap.run)}`);
    },
    { timeout: 20_000, interval: 100 },
  );
}

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
  const res = await app.request(`/rpc/${proc}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, origin: "http://127.0.0.1:5173" },
    body: JSON.stringify({ json: body }),
  });
  const text = await res.text();
  const parsed = JSON.parse(text) as { json?: T; error?: { message?: string } };
  if (res.status >= 400 || parsed.error) {
    throw new Error(`${proc} ${res.status}: ${parsed.error?.message ?? text}`);
  }
  return discardBotIntroFromCreate(botIntroHarness, cookie, proc, parsed.json as T);
}
