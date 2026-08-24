import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ComposioEmulator } from "@rakazo/adapters";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sessionCookieHeader } from "./index.js";

type App = { request: (input: string, init?: RequestInit) => Promise<Response> };
type AppHandles = Awaited<ReturnType<typeof import("../../../apps/api/src/app.ts").createApp>>;

process.env.WAKEUP_DRIVER = "memory";
process.env.SANDBOX_PROVIDER = "fake";
process.env.AGENT_RUNTIME = "scripted";

const hasDb = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const describeWithDatabase = hasDb ? describe : describe.skip;

describeWithDatabase("structured @ mention targets", () => {
  let handles: AppHandles;
  let app: App;
  let prisma: AppHandles["prisma"];
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const dataDir = mkdtempSync(path.join(tmpdir(), "rakazo-mention-targets-"));

  beforeAll(async () => {
    const { createApp } = await import("../../../apps/api/src/app.ts");
    handles = await createApp({
      databaseUrl: process.env.DATABASE_URL!,
      dataDir,
      sandboxProvider: "fake",
      agentRuntime: "scripted",
      composio: new ComposioEmulator(),
      signupsEnabled: "true",
    });
    app = handles.app;
    prisma = handles.prisma;
  });

  afterAll(async () => {
    await handles?.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("starts a routine test run on the owning bot", async () => {
    const cookie = await signup(app, `mention-routine-${stamp}@rakazo.test`, "Routine Owner");
    const bot = await rpc<{ id: string }>(app, cookie, "bots/create", {
      name: "Chief",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    const routine = await rpc<{ id: string }>(app, cookie, "routines/create", {
      botId: bot.id,
      name: "Daily digest",
      prompt: "Summarize inbox",
      cron: "0 9 * * 1",
      timezone: "UTC",
      notify: false,
      active: false,
    });
    const tested = await rpc<{ runId: string }>(app, cookie, "routines/testRun", {
      routineId: routine.id,
    });
    const run = await prisma.run.findUniqueOrThrow({ where: { id: tested.runId } });
    expect(run.botId).toBe(bot.id);
    expect(run.trigger).toBe("routine");
  });

  it("replays routine testRun with the same clientNonce", async () => {
    const cookie = await signup(app, `mention-routine-replay-${stamp}@rakazo.test`, "Replay Owner");
    const bot = await rpc<{ id: string }>(app, cookie, "bots/create", {
      name: "ReplayBot",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    const routine = await rpc<{ id: string }>(app, cookie, "routines/create", {
      botId: bot.id,
      name: "Replay digest",
      prompt: "Replay inbox",
      cron: "0 9 * * 1",
      timezone: "UTC",
      notify: false,
      active: false,
    });
    const nonce = `routine-mention:${stamp}:replay`;
    const first = await rpc<{ runId: string }>(app, cookie, "routines/testRun", {
      routineId: routine.id,
      clientNonce: nonce,
    });
    const second = await rpc<{ runId: string }>(app, cookie, "routines/testRun", {
      routineId: routine.id,
      clientNonce: nonce,
    });
    expect(second.runId).toBe(first.runId);
    expect(
      await prisma.run.count({
        where: { clientNonce: `routine-test:${nonce}` },
      }),
    ).toBe(1);
    const replayed = await prisma.run.findUniqueOrThrow({ where: { id: first.runId } });
    expect(replayed.clientNonce).toBe(`routine-test:${nonce}`);
  });

  it("includes connector intent on a 1:1 send prompt", async () => {
    const cookie = await signup(app, `mention-connector-${stamp}@rakazo.test`, "Connector Owner");
    const bot = await rpc<{ id: string }>(app, cookie, "bots/create", {
      name: "Chief",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    const started = await rpc<{ connectionId: string }>(app, cookie, "connections/begin", {
      provider: "gmail",
      displayName: "Gmail",
    });
    await rpc(app, cookie, "connections/complete", { connectionId: started.connectionId });

    const sent = await rpc<{ runId: string }>(app, cookie, "threads/send", {
      botId: bot.id,
      text: "check my email",
      mentions: [{ kind: "connection", id: started.connectionId }],
    });
    const run = await prisma.run.findUniqueOrThrow({
      where: { id: sent.runId },
      include: { task: true },
    });
    expect(run.task.prompt).toContain("Use these connectors if relevant: Gmail");
  });

  it("delivers a send to a group whose picker name contains a space", async () => {
    const cookie = await signup(app, `mention-space-group-${stamp}@rakazo.test`, "Space Group");
    const botA = await rpc<{ id: string }>(app, cookie, "bots/create", {
      name: "BotA",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    const botB = await rpc<{ id: string }>(app, cookie, "bots/create", {
      name: "BotB",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    const group = await rpc<{ id: string }>(app, cookie, "groups/create", {
      name: "Draft team",
      botIds: [botA.id, botB.id],
    });
    const messageText = "picker-selected Draft team target";
    await rpc(app, cookie, "threads/send", {
      groupId: group.id,
      text: messageText,
      mentions: [{ kind: "group", id: group.id }],
    });
    const groupSnap = await rpc<{
      messages: Array<{ blocks: Array<{ kind: string; text?: string }> }>;
    }>(app, cookie, "threads/get", { groupId: group.id });
    expect(
      groupSnap.messages.some((message) =>
        message.blocks.some((block) => block.kind === "text" && block.text?.includes(messageText)),
      ),
    ).toBe(true);
  });

  it("starts only a routine run for a space-named routine mention", async () => {
    const cookie = await signup(app, `mention-space-routine-${stamp}@rakazo.test`, "Space Routine");
    const bot = await rpc<{ id: string }>(app, cookie, "bots/create", {
      name: "Chief",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    const routine = await rpc<{ id: string }>(app, cookie, "routines/create", {
      botId: bot.id,
      name: "Daily digest",
      prompt: "Summarize inbox",
      cron: "0 9 * * 1",
      timezone: "UTC",
      notify: false,
      active: false,
    });
    const userRunsBefore = await prisma.run.count({
      where: { botId: bot.id, trigger: "user" },
    });
    const routineRunsBefore = await prisma.run.count({
      where: { botId: bot.id, trigger: "routine" },
    });
    await rpc<{ runId: string }>(app, cookie, "routines/testRun", { routineId: routine.id });
    expect(await prisma.run.count({ where: { botId: bot.id, trigger: "user" } })).toBe(
      userRunsBefore,
    );
    expect(await prisma.run.count({ where: { botId: bot.id, trigger: "routine" } })).toBe(
      routineRunsBefore + 1,
    );
  });

  it("lands a group-targeted send in the group transcript, not the 1:1 bot thread", async () => {
    const cookie = await signup(app, `mention-group-${stamp}@rakazo.test`, "Group Owner");
    const botA = await rpc<{ id: string }>(app, cookie, "bots/create", {
      name: "BotA",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    const botB = await rpc<{ id: string }>(app, cookie, "bots/create", {
      name: "BotB",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    const group = await rpc<{ id: string; threadId: string }>(app, cookie, "groups/create", {
      name: "Planning",
      botIds: [botA.id, botB.id],
    });
    const messageText = "follow up from 1:1 reroute";
    await rpc(app, cookie, "threads/send", {
      groupId: group.id,
      text: messageText,
    });
    const groupSnap = await rpc<{
      messages: Array<{ blocks: Array<{ kind: string; text?: string }> }>;
    }>(app, cookie, "threads/get", { groupId: group.id });
    const botSnap = await rpc<{
      messages: Array<{ blocks: Array<{ kind: string; text?: string }> }>;
    }>(app, cookie, "threads/get", { botId: botA.id });
    const groupHasMessage = groupSnap.messages.some((message) =>
      message.blocks.some((block) => block.kind === "text" && block.text?.includes(messageText)),
    );
    const botHasMessage = botSnap.messages.some((message) =>
      message.blocks.some((block) => block.kind === "text" && block.text?.includes(messageText)),
    );
    expect(groupHasMessage).toBe(true);
    expect(botHasMessage).toBe(false);
  });

  it("wakes exactly one bot on an unmentioned group send", async () => {
    const cookie = await signup(app, `mention-group-default-${stamp}@rakazo.test`, "Group Default");
    const botA = await rpc<{ id: string }>(app, cookie, "bots/create", {
      name: "BotA",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    const botB = await rpc<{ id: string }>(app, cookie, "bots/create", {
      name: "BotB",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    const group = await rpc<{ id: string; threadId: string }>(app, cookie, "groups/create", {
      name: "Squad",
      botIds: [botA.id, botB.id],
    });
    const before = await prisma.run.count({
      where: { threadId: group.threadId, trigger: "user" },
    });
    await rpc(app, cookie, "threads/send", { groupId: group.id, text: "hello team" });
    const after = await prisma.run.count({
      where: { threadId: group.threadId, trigger: "user" },
    });
    expect(after - before).toBe(1);
  });

  it("rejects another user's routine, connection, and group mentions", async () => {
    const ada = await signup(app, `mention-auth-ada-${stamp}@rakazo.test`, "Ada Auth");
    const bob = await signup(app, `mention-auth-bob-${stamp}@rakazo.test`, "Bob Auth");
    const adaBot = await rpc<{ id: string }>(app, ada, "bots/create", {
      name: "AdaBot",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    const bobBot = await rpc<{ id: string }>(app, bob, "bots/create", {
      name: "BobBot",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    const adaBotB = await rpc<{ id: string }>(app, ada, "bots/create", {
      name: "AdaBotB",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    const routine = await rpc<{ id: string }>(app, ada, "routines/create", {
      botId: adaBot.id,
      name: "Private routine",
      prompt: "do work",
      cron: "0 9 * * 1",
      timezone: "UTC",
      notify: false,
      active: false,
    });
    const started = await rpc<{ connectionId: string }>(app, ada, "connections/begin", {
      provider: "gmail",
      displayName: "Gmail",
    });
    await rpc(app, ada, "connections/complete", { connectionId: started.connectionId });
    const group = await rpc<{ id: string }>(app, ada, "groups/create", {
      name: "Ada group",
      botIds: [adaBot.id, adaBotB.id],
    });

    const routineAttempt = await raw(app, bob, "routines/testRun", { routineId: routine.id });
    expect(routineAttempt.status).toBeGreaterThanOrEqual(400);

    const connectionAttempt = await raw(app, bob, "threads/send", {
      botId: bobBot.id,
      text: "use connector",
      mentions: [{ kind: "connection", id: started.connectionId }],
    });
    expect(connectionAttempt.status).toBeGreaterThanOrEqual(400);

    const groupAttempt = await raw(app, bob, "threads/send", {
      groupId: group.id,
      text: "intrude",
    });
    expect(groupAttempt.status).toBeGreaterThanOrEqual(400);

    const routineRuns = await prisma.run.count({ where: { botId: adaBot.id, trigger: "routine" } });
    expect(routineRuns).toBe(0);
  });
});

async function signup(app: App, email: string, name: string) {
  const res = await app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "http://127.0.0.1:5173",
    },
    body: JSON.stringify({ email, password: "password12", name }),
  });
  if (res.status >= 400) {
    throw new Error(`signup failed ${res.status}: ${await res.text()}`);
  }
  return sessionCookieHeader(res);
}

async function raw(app: App, cookie: string, proc: string, body: unknown = {}) {
  return app.request(`/rpc/${proc}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie,
      origin: "http://127.0.0.1:5173",
    },
    body: JSON.stringify({ json: body }),
  });
}

async function rpc<T>(app: App, cookie: string, proc: string, body: unknown = {}): Promise<T> {
  const res = await raw(app, cookie, proc, body);
  const text = await res.text();
  let parsed: { json?: T; error?: { message?: string } };
  try {
    parsed = JSON.parse(text) as { json?: T; error?: { message?: string } };
  } catch {
    throw new Error(`${proc} ${res.status}: ${text}`);
  }
  if (res.status >= 400 || parsed.error) {
    throw new Error(`${proc} ${res.status}: ${parsed.error?.message ?? text}`);
  }
  return parsed.json as T;
}
