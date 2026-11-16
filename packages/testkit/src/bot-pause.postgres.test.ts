import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Bot } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { pauseBot, resumeBot, runAsTenant } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sessionCookieHeader } from "./index.js";
import { asSystem } from "./system-db.js";

type App = { request: (input: string, init?: RequestInit) => Response | Promise<Response> };

process.env.WAKEUP_DRIVER = "memory";
process.env.SANDBOX_PROVIDER = "fake";
process.env.AGENT_RUNTIME = "scripted";

const hasDb = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("a paused bot", () => {
  let app: App;
  let prisma: PrismaClient;
  let system: PrismaClient;
  let stop: () => Promise<void>;
  const dataDir = mkdtempSync(path.join(tmpdir(), "rakazo-bot-pause-"));
  const events = { notify: async () => undefined };

  beforeAll(async () => {
    const { createApp } = await import("@rakazo/api/app");
    const handles = await createApp({
      databaseUrl: process.env.DATABASE_URL!,
      dataDir,
      sandboxProvider: "fake",
      agentRuntime: "scripted",
    });
    app = handles.app;
    prisma = handles.prisma;
    system = asSystem(handles.prisma);
    stop = handles.stop;
  });

  afterAll(async () => {
    await stop?.();
  });

  it("refuses new messages until it is resumed, and records who did it", async () => {
    const cookie = await signup(app, `pause-${Date.now()}@rakazo.test`);
    const bot = await rpc<Bot>(app, cookie, "bots/create", {
      name: "Pausable",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: false,
    });
    const row = await system.bot.findUniqueOrThrow({
      where: { id: bot.id },
      select: { userId: true, spaceId: true },
    });
    const actor = {
      userId: row.userId,
      spaceId: row.spaceId,
      email: "",
      isDeploymentOwner: false,
    };
    const asOwner = <T>(fn: () => Promise<T>) => runAsTenant(actor, fn);
    const pause = () => asOwner(() => pauseBot(prisma, events, actor, bot.id));
    const resume = () => asOwner(() => resumeBot(prisma, actor, bot.id));
    const send = (text: string) => rpc(app, cookie, "threads/send", { botId: bot.id, text });

    await pause();
    await expect(send("hello")).rejects.toThrow(/threads\/send 409:.*This bot is paused/);
    const refused = await rpc<{ messages: unknown[] }>(app, cookie, "threads/get", {
      botId: bot.id,
    });
    expect(JSON.stringify(refused.messages)).not.toContain("hello");

    // Pausing twice and resuming twice each leave one audit row.
    await pause();
    await resume();
    await resume();
    await expect(send("hello again")).resolves.toBeDefined();

    const audit = await system.auditEvent.findMany({
      where: { targetId: bot.id, action: { in: ["bot.paused", "bot.resumed"] } },
      select: { action: true, actorId: true },
      orderBy: { createdAt: "asc" },
    });
    expect(audit).toEqual([
      { action: "bot.paused", actorId: row.userId },
      { action: "bot.resumed", actorId: row.userId },
    ]);
  });
});

async function signup(app: App, email: string) {
  const response = await app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://127.0.0.1:5173" },
    body: JSON.stringify({ email, password: "test-password-123", name: "Pause User" }),
  });
  expect(response.status).toBeLessThan(400);
  return sessionCookieHeader(response);
}

async function rpc<T>(app: App, cookie: string, proc: string, body: unknown = {}): Promise<T> {
  const response = await app.request(`/rpc/${proc}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, origin: "http://127.0.0.1:5173" },
    body: JSON.stringify({ json: body }),
  });
  const text = await response.text();
  if (response.status >= 400) throw new Error(`${proc} ${response.status}: ${text}`);
  return (JSON.parse(text) as { json: T }).json;
}
