import { execFile, execFileSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import {
  ComposioEmulator,
  EmailEmulator,
  PipedreamConnector,
  ThirdPartyConnectorEmulator,
} from "@rakazo/adapters";
import { createThreadMessage, type PrismaClient } from "@rakazo/db";
import { sessionCookieHeader } from "../index.js";
import { runProcess } from "./process.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const REPORT_DIR = path.join(ROOT, "test-report", "mobile-screenshots");
const DATA_DIR = path.join(ROOT, ".tmp", "mobile-screenshots-data");
const FLOW_DIR = path.join(ROOT, "apps", "mobile", ".maestro");
const EMAIL = "mobile-screenshots@example.test";
const PASSWORD = "test-password-123";
const API_PORT = 3110;
const DEVICE_CONTROL_PORT = 3111;
const HOST_API_URL = `http://127.0.0.1:${API_PORT}`;
const DEVICE_CONTROL_URL = `http://127.0.0.1:${DEVICE_CONTROL_PORT}`;
const EXPAND_NOTIFICATIONS_URL = `${DEVICE_CONTROL_URL}/expand-notifications`;
const WEB_ORIGIN = "http://127.0.0.1:5180";

type App = { request: (input: string, init?: RequestInit) => Response | Promise<Response> };

/** Capture app screenshots and the notification demo against an isolated, disposable backend. */
async function main() {
  process.chdir(ROOT);
  configureEnvironment();
  await rm(REPORT_DIR, { recursive: true, force: true });
  await rm(DATA_DIR, { recursive: true, force: true });
  await mkdir(REPORT_DIR, { recursive: true });
  await mkdir(DATA_DIR, { recursive: true });

  execFileSync("pnpm", ["--filter", "@rakazo/db", "exec", "prisma", "migrate", "deploy"], {
    cwd: path.join(ROOT, "packages", "db"),
    env: process.env,
    stdio: "inherit",
  });
  const thirdParties = new ThirdPartyConnectorEmulator();
  const pipedream = new PipedreamConnector(
    {
      clientId: "fake-client-id",
      clientSecret: "fake-client-secret",
      projectId: "fake-project-id",
      environment: "development",
      identitySecret: process.env.ENCRYPTION_KEY!,
    },
    { fetch: thirdParties.fetch, resolveHostname: thirdParties.resolveHostname },
  );
  const { createApp } = await import("../../../../apps/api/src/app.ts");
  const handles = await createApp({
    databaseUrl: process.env.DATABASE_URL!,
    dataDir: DATA_DIR,
    apiHost: "0.0.0.0",
    apiUrl: HOST_API_URL,
    composio: new ComposioEmulator(),
    pipedream,
    email: new EmailEmulator(),
    remoteConnectors: {
      fetch: thirdParties.fetch,
      resolveHostname: thirdParties.resolveHostname,
    },
  });

  const fixture = await seedFixture(handles.app, handles.prisma);
  const server = serve({
    fetch: handles.app.fetch,
    hostname: "0.0.0.0",
    port: API_PORT,
  });
  const deviceControl = startDeviceControlServer();

  try {
    await waitForHealth(`${HOST_API_URL}/health`, 15_000);
    for (const flow of ["screenshots", "notification-demo"]) {
      await runProcess(
        "maestro",
        [
          "test",
          "--no-ansi",
          "--flatten-debug-output",
          "--debug-output",
          path.join(REPORT_DIR, "debug", flow),
          "--test-output-dir",
          REPORT_DIR,
          "--format",
          "HTML",
          "--output",
          path.join(REPORT_DIR, `${flow}.html`),
          "-e",
          `RAKAZO_SCREENSHOT_EMAIL=${EMAIL}`,
          "-e",
          `RAKAZO_SCREENSHOT_PASSWORD=${PASSWORD}`,
          "-e",
          `RAKAZO_SCREENSHOT_BOT_ID=${fixture.botId}`,
          "-e",
          `RAKAZO_SCREENSHOT_GROUP_ID=${fixture.groupId}`,
          "-e",
          `RAKAZO_SCREENSHOT_ROUTINE_ID=${fixture.routineId}`,
          "-e",
          `RAKAZO_NOTIFICATION_VIDEO=${path.join(REPORT_DIR, "notification-demo")}`,
          "-e",
          `RAKAZO_EXPAND_NOTIFICATIONS_URL=${EXPAND_NOTIFICATIONS_URL}`,
          path.join(FLOW_DIR, `${flow}.yaml`),
        ],
        process.env,
      );
    }
    await writeFile(
      path.join(REPORT_DIR, "summary.json"),
      `${JSON.stringify({ ok: true }, null, 2)}\n`,
    );
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
    await new Promise<void>((resolve, reject) => {
      deviceControl.close((error) => (error ? reject(error) : resolve()));
    }).catch(() => undefined);
    await handles.stop().catch(() => undefined);
    await rm(DATA_DIR, { recursive: true, force: true });
  }
}

/** Maestro host-side helper: expand the Android shade without flaky status-bar swipes. */
function startDeviceControlServer(): Server {
  const server = createServer((req, res) => {
    if (req.method !== "GET" || req.url !== "/expand-notifications") {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("not found");
      return;
    }
    execFile(
      "adb",
      ["shell", "cmd", "statusbar", "expand-notifications"],
      { timeout: 5_000 },
      (error) => {
        res.writeHead(error ? 500 : 200, { "content-type": "text/plain; charset=utf-8" });
        res.end(error ? "Could not expand notifications" : "ok");
      },
    );
  });
  server.listen(DEVICE_CONTROL_PORT, "127.0.0.1");
  return server;
}

function configureEnvironment() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required for the isolated mobile screenshot fixture");
  }
  Object.assign(process.env, {
    NODE_ENV: "test",
    WAKEUP_DRIVER: "memory",
    SANDBOX_PROVIDER: "fake",
    AGENT_RUNTIME: "scripted",
    COMPOSIO_API_KEY: "",
    BETTER_AUTH_SECRET: "mobile-screenshot-auth-secret-32chars",
    ENCRYPTION_KEY: "mobile-screenshot-encryption-key-32chars",
    SCREEN_PROXY_SECRET: "mobile-screenshot-screen-secret-32chars",
    BETTER_AUTH_URL: HOST_API_URL,
    WEB_ORIGIN,
    API_HOST: "0.0.0.0",
    API_PORT: String(API_PORT),
    API_URL: HOST_API_URL,
    DATA_DIR,
    SIGNUPS_ENABLED: "true",
    SIGNUP_ALLOWLIST: "",
    CI: "1",
  });
}

async function seedFixture(app: App, prisma: PrismaClient) {
  const cookie = await signup(app);
  const researcher = await rpc<{ id: string }>(app, cookie, "bots/create", {
    name: "Researcher",
    title: "Product research",
    description: "Finds evidence and keeps fixture notes organized.",
    instructions: "Find evidence and summarize it clearly.",
    notifyOnFinish: true,
  });
  const writer = await rpc<{ id: string }>(app, cookie, "bots/create", {
    name: "Writer",
    title: "Clear writing",
    description: "Turns research into concise drafts.",
    instructions: "Write concise drafts from the available evidence.",
    notifyOnFinish: true,
  });
  const support = await rpc<{ id: string }>(app, cookie, "bots/create", {
    name: "Support",
    title: "Customer support",
    description: "Prepares friendly customer replies.",
    instructions: "Prepare accurate and friendly customer replies.",
    notifyOnFinish: false,
  });
  const archived = await rpc<{ id: string }>(app, cookie, "bots/create", {
    name: "Archived fixture",
    title: "Archived",
    description: "A recoverable archived bot for account screenshots.",
    instructions: "Remain archived.",
    notifyOnFinish: true,
  });
  await rpc(app, cookie, "bots/archive", { botId: archived.id });

  const group = await rpc<{ id: string }>(app, cookie, "groups/create", {
    name: "Launch team",
    botIds: [researcher.id, writer.id, support.id],
  });
  const routine = await rpc<{ id: string }>(app, cookie, "routines/create", {
    botId: researcher.id,
    name: "Weekly fixture review",
    prompt: "Review the fixture launch notes and summarize the open questions.",
    crons: ["0 9 * * 1"],
    timezone: "UTC",
    active: true,
    notify: true,
  });

  const botThread = await prisma.thread.findUniqueOrThrow({ where: { botId: researcher.id } });
  const groupThread = await prisma.thread.findUniqueOrThrow({ where: { groupId: group.id } });
  const question = await createThreadMessage(prisma, {
    threadId: botThread.id,
    role: "user",
    blocks: [{ kind: "text", text: "Summarize the fixture launch checklist." }],
  });
  await createThreadMessage(prisma, {
    threadId: botThread.id,
    role: "bot",
    botId: researcher.id,
    blocks: [{ kind: "text", text: "The fixture workspace is ready." }],
  });
  await createThreadMessage(prisma, {
    threadId: groupThread.id,
    role: "user",
    blocks: [{ kind: "text", text: "Coordinate the fixture launch plan." }],
  });
  await createThreadMessage(prisma, {
    threadId: groupThread.id,
    role: "bot",
    botId: writer.id,
    blocks: [{ kind: "text", text: "The fixture launch plan is ready." }],
  });

  const task = await prisma.task.create({
    data: {
      spaceId: botThread.spaceId,
      userId: botThread.userId,
      botId: researcher.id,
      threadId: botThread.id,
      prompt: "Prepare the fixture workspace",
      status: "completed",
    },
  });
  await prisma.run.create({
    data: {
      spaceId: botThread.spaceId,
      userId: botThread.userId,
      botId: researcher.id,
      threadId: botThread.id,
      taskId: task.id,
      status: "completed",
      trigger: "user",
      modelProvider: "scripted",
      modelId: "scripted",
      sourceMessageId: question.id,
      startedAt: new Date(Date.now() - 2_000),
      completedAt: new Date(),
    },
  });

  return { botId: researcher.id, groupId: group.id, routineId: routine.id };
}

async function signup(app: App) {
  const response = await app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json", origin: WEB_ORIGIN },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD, name: "Screenshot User" }),
  });
  if (!response.ok) throw new Error(`Fixture signup failed with ${response.status}`);
  const cookie = sessionCookieHeader(response);
  if (!cookie) throw new Error("Fixture signup did not return a session cookie");
  return cookie;
}

async function rpc<T>(app: App, cookie: string, procedure: string, body: unknown = {}): Promise<T> {
  const response = await app.request(`/rpc/${procedure}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie,
      origin: WEB_ORIGIN,
    },
    body: JSON.stringify({ json: body }),
  });
  const text = await response.text();
  const parsed = JSON.parse(text) as { json?: T; error?: { message?: string } };
  if (!response.ok || parsed.error) {
    throw new Error(`${procedure} ${response.status}: ${parsed.error?.message ?? text}`);
  }
  return parsed.json as T;
}

async function waitForHealth(url: string, timeoutMs: number) {
  const startedAt = Date.now();
  let lastError = "no response";
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Mobile screenshot API did not become ready: ${lastError}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
