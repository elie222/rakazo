import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ToolCallRecord } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { createToolCallRecord } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sessionCookieHeader } from "../index.js";
import { asSystem } from "../system-db.js";

type App = { request: (input: string, init?: RequestInit) => Response | Promise<Response> };

process.env.WAKEUP_DRIVER = "memory";
process.env.SANDBOX_PROVIDER = "fake";
process.env.AGENT_RUNTIME = "scripted";

const hasDb = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const describeToolCalls = hasDb ? describe : describe.skip;

describeToolCalls("a run's kept tool calls", () => {
  let app: App;
  let prisma: PrismaClient;
  let stop: () => Promise<void>;
  const stamp = Date.now();
  const dataDir = mkdtempSync(path.join(tmpdir(), "rakazo-tool-calls-"));

  beforeAll(async () => {
    const { createApp } = await import("@rakazo/api/app");
    const handles = await createApp({
      databaseUrl: process.env.DATABASE_URL!,
      dataDir,
      sandboxProvider: "fake",
      agentRuntime: "scripted",
    });
    app = handles.app;
    prisma = asSystem(handles.prisma);
    stop = handles.stop;
  });

  afterAll(async () => {
    await stop?.();
  });

  it("hands a run's kept calls to the person whose run it is, and to nobody else", async () => {
    const cookie = await signup(app, `tools-${stamp}@rakazo.test`, "Tools User");
    const bot = await rpc<{ id: string }>(app, cookie, "bots/create", {
      name: "Worker",
      title: "Worker",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    const run = await seedRun(prisma, bot.id);
    await createToolCallRecord(prisma, {
      spaceId: run.spaceId,
      threadId: run.threadId,
      botId: bot.id,
      runId: run.id,
      executionId: "exec-1",
      tool: "Search inbox",
      durationMs: 1840,
      outcome: "failed",
      arguments: '{"query":"from:anna"}',
      error: "Mailbox authorization expired",
    });

    const mine = await rpc<{ calls: ToolCallRecord[] }>(app, cookie, "runs/toolCalls", {
      runId: run.id,
    });
    expect(mine.calls).toHaveLength(1);
    expect(mine.calls[0]).toMatchObject({
      executionId: "exec-1",
      tool: "Search inbox",
      outcome: "failed",
      error: "Mailbox authorization expired",
    });

    const strangerCookie = await signup(app, `tools-stranger-${stamp}@rakazo.test`, "Stranger");
    const theirs = await rpc<{ calls: ToolCallRecord[] }>(app, strangerCookie, "runs/toolCalls", {
      runId: run.id,
    });
    expect(theirs.calls).toEqual([]);
  });

  it("keeps a Space's records by default and lets its owner stop", async () => {
    const cookie = await signup(app, `tools-space-${stamp}@rakazo.test`, "Space Owner");

    const initial = await rpc<{ keeps: boolean; canManage: boolean }>(
      app,
      cookie,
      "spaceSettings/keepToolCallRecords",
    );
    expect(initial).toEqual({ keeps: true, canManage: true });

    const stopped = await rpc<{ keeps: boolean }>(
      app,
      cookie,
      "spaceSettings/setKeepToolCallRecords",
      {
        keeps: false,
      },
    );
    expect(stopped).toEqual({ keeps: false });
    expect(await rpc(app, cookie, "spaceSettings/keepToolCallRecords")).toEqual({
      keeps: false,
      canManage: true,
    });

    await rpc(app, cookie, "spaceSettings/setKeepToolCallRecords", { keeps: true });
  });
});

async function seedRun(prisma: PrismaClient, botId: string) {
  const thread = await prisma.thread.findUniqueOrThrow({ where: { botId } });
  const task = await prisma.task.create({
    data: {
      spaceId: thread.spaceId,
      userId: thread.userId,
      botId,
      threadId: thread.id,
      prompt: "read the inbox",
      status: "completed",
    },
  });
  const run = await prisma.run.create({
    data: {
      spaceId: thread.spaceId,
      userId: thread.userId,
      botId,
      threadId: thread.id,
      taskId: task.id,
      status: "completed",
      trigger: "user",
      completedAt: new Date(),
    },
  });
  return { id: run.id, spaceId: thread.spaceId, threadId: thread.id };
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
    headers: {
      "content-type": "application/json",
      cookie,
      origin: "http://127.0.0.1:5173",
    },
    body: JSON.stringify({ json: body }),
  });
  const text = await res.text();
  const parsed = JSON.parse(text) as { json?: T; error?: { message?: string } };
  if (res.status >= 400 || parsed.error) {
    throw new Error(`${proc} ${res.status}: ${parsed.error?.message ?? text}`);
  }
  return parsed.json as T;
}
