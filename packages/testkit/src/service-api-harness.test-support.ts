import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { createApp } from "@rakazo/api/app";
import type {
  Actor,
  Bot,
  ServiceCredential,
  ServiceRouteDefinition,
  ServiceScope,
} from "@rakazo/contracts";
import { SERVICE_API_PREFIX, SERVICE_ROUTES, SERVICE_SCOPES } from "@rakazo/contracts";
import { afterAll, beforeAll, describe, expect } from "vitest";
import type { BotIntroHarness } from "./discard-bot-intro.js";
import { discardBotIntroFromCreate } from "./discard-bot-intro.js";
import { sessionCookieHeader } from "./index.js";
import { asSystem } from "./system-db.js";

type App = { request: (input: string, init?: RequestInit) => Response | Promise<Response> };
type AppHandles = Awaited<ReturnType<typeof createApp>>;

process.env.WAKEUP_DRIVER = "memory";
process.env.SANDBOX_PROVIDER = "fake";
process.env.AGENT_RUNTIME = "scripted";
process.env.TICKET_BOARD_ENABLED = "true";

const hasDb = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
export const describeWithDatabase = hasDb ? describe : describe.skip;
const ORIGIN = "http://127.0.0.1:5173";
export const ROUTES = Object.entries(SERVICE_ROUTES) as Array<[string, ServiceRouteDefinition]>;
export const EVERY_SCOPE = [...SERVICE_SCOPES] as ServiceScope[];

export type ServiceApiHarness = ReturnType<typeof serviceApiHarness>;

/** Starts the app for a service API suite. Call inside its describe; `app` and `db` exist from beforeAll. */
export function serviceApiHarness() {
  let handles: AppHandles;
  let app: App;
  let db: AppHandles["prisma"];
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const dataDir = mkdtempSync(path.join(tmpdir(), "rakazo-service-surface-"));
  let sequence = 0;
  const answered = new Set<string>();

  const rpc = async <T>(cookie: string, procedure: string, body: unknown = {}) => {
    const response = await app.request(`/rpc/${procedure}`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin: ORIGIN },
      body: JSON.stringify({ json: body }),
    });
    const payload = (await response.json()) as { json?: T };
    if (response.status >= 400) throw new Error(`${procedure} ${response.status}`);
    return discardBotIntroFromCreate(
      handles as BotIntroHarness,
      cookie,
      procedure,
      payload.json as T,
    );
  };
  const person = async () => {
    sequence += 1;
    const response = await app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify({
        email: `surface-${sequence}-${stamp}@rakazo.test`,
        password: "password12",
        name: `Surface ${sequence}`,
      }),
    });
    const cookie = sessionCookieHeader(response);
    await app.request("/api/auth/confirm-identity", {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin: ORIGIN },
      body: JSON.stringify({ password: "password12" }),
    });
    return { cookie, actor: await rpc<Actor>(cookie, "me") };
  };
  const newBot = (cookie: string, name: string) =>
    rpc<Bot>(cookie, "bots/create", {
      name,
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: false,
    });
  const newKey = (cookie: string, scopes: ServiceScope[] = EVERY_SCOPE, botIds: string[] = []) =>
    rpc<{ credential: ServiceCredential; token: string }>(cookie, "serviceCredentials/create", {
      name: `key-${crypto.randomUUID().slice(0, 8)}`,
      scopes,
      botIds,
      expiresInDays: 30,
    });

  const api = async <T = Record<string, never>>(
    token: string | null,
    method: string,
    suffix: string,
    options: { body?: unknown; key?: string } = {},
  ) => {
    const response = await app.request(`${SERVICE_API_PREFIX}${suffix}`, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(options.body === undefined ? {} : { "content-type": "application/json" }),
        ...(options.key ? { "idempotency-key": options.key } : {}),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    const text = await response.text();
    if (response.status === 200) {
      const route = ROUTES.find(
        ([, definition]) =>
          definition.method === method &&
          new RegExp(`^${definition.path.replace(/:[A-Za-z]+/g, "[^/]+")}$`).test(
            suffix.split("?")[0] ?? "",
          ),
      );
      if (route) answered.add(route[0]);
    }
    return {
      status: response.status,
      headers: response.headers,
      json: (text ? JSON.parse(text) : null) as T & { error?: { code: string } },
    };
  };
  const ok = async <T = Record<string, never>>(...args: Parameters<typeof api>): Promise<T> => {
    const result = await api<T>(...args);
    expect(result.status, JSON.stringify(result.json)).toBe(200);
    return result.json;
  };

  /** Fills path parameters so every route can be reached by a table-driven check. */
  const concrete = (definition: ServiceRouteDefinition, botId: string) =>
    definition.path.replace(/:([A-Za-z]+)/g, (_, name: string) =>
      name === "botId" ? botId : "absent",
    );

  beforeAll(async () => {
    const { createApp } = await import("@rakazo/api/app");
    handles = await createApp({
      databaseUrl: process.env.DATABASE_URL!,
      encryptionKey: "offline-service-surface-encryption-key",
      dataDir,
      sandboxProvider: "fake",
      agentRuntime: "scripted",
      wakeupDriver: "memory",
      signupsEnabled: "true",
    });
    app = handles.app;
    db = asSystem(handles.prisma);
  });

  afterAll(async () => {
    await handles?.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  const threadOf = async (cookie: string, botId: string) =>
    (await rpc<{ threadId: string }>(cookie, "threads/head", { botId })).threadId;

  /** Work with no worker behind it, so the bot stays busy for as long as a test needs. */
  const busyRun = async (threadId: string) => {
    const thread = await db.thread.findUniqueOrThrow({ where: { id: threadId } });
    if (!thread.botId) throw new Error("expected a bot's thread");
    const owner = { spaceId: thread.spaceId, userId: thread.userId, botId: thread.botId, threadId };
    const task = await db.task.create({
      data: { ...owner, prompt: "the owner's work", status: "running" },
    });
    const run = await db.run.create({
      data: { ...owner, taskId: task.id, status: "running", trigger: "user" },
    });
    return { runId: run.id };
  };

  return {
    get app() {
      return app;
    },
    get db() {
      return db;
    },
    answered,
    rpc,
    person,
    newBot,
    newKey,
    api,
    ok,
    concrete,
    threadOf,
    busyRun,
  };
}
