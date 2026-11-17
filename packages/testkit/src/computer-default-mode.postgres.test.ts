import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Bot } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { sessionCookieHeader } from "./index.js";
import { asSystem } from "./system-db.js";

type App = { request: (input: string, init?: RequestInit) => Response | Promise<Response> };

process.env.WAKEUP_DRIVER = "memory";
process.env.SANDBOX_PROVIDER = "fake";
process.env.AGENT_RUNTIME = "scripted";

const hasDb = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("COMPUTER_DEFAULT_MODE for new bots", () => {
  let app: App;
  let prisma: PrismaClient;
  let stop: () => Promise<void>;
  const dataDir = mkdtempSync(path.join(tmpdir(), "rakazo-computer-default-"));

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

  afterEach(() => {
    delete process.env.COMPUTER_DEFAULT_MODE;
  });

  afterAll(async () => {
    await stop?.();
  });

  const create = (cookie: string, name: string, computerMode?: "team" | "dedicated") =>
    rpc<Bot>(app, cookie, "bots/create", {
      name,
      title: name,
      description: "",
      instructions: "",
      notifyOnFinish: true,
      ...(computerMode ? { computerMode } : {}),
    });
  const computerOf = async (botId: string) =>
    (
      await prisma.bot.findUniqueOrThrow({
        where: { id: botId },
        select: { computer: { select: { id: true, scope: true } } },
      })
    ).computer;

  it("gives a bot a Team computer when nothing is configured", async () => {
    const cookie = await signup(app, `default-team-${Date.now()}@rakazo.test`);
    const bot = await create(cookie, "Shared");
    expect(bot.computerMode).toBe("team");
    expect((await computerOf(bot.id))?.scope).toBe("team");
  });

  it("follows the deployment default, and an explicit choice still wins", async () => {
    const cookie = await signup(app, `default-private-${Date.now()}@rakazo.test`);
    process.env.COMPUTER_DEFAULT_MODE = "dedicated";

    const first = await create(cookie, "Private one");
    const second = await create(cookie, "Private two");
    expect(first.computerMode).toBe("dedicated");
    const firstComputer = await computerOf(first.id);
    const secondComputer = await computerOf(second.id);
    expect(firstComputer?.scope).toBe("dedicated");
    expect(secondComputer?.id).not.toBe(firstComputer?.id);

    const explicit = await create(cookie, "Shared anyway", "team");
    expect(explicit.computerMode).toBe("team");
    expect((await computerOf(explicit.id))?.scope).toBe("team");
  });

  it("leaves an existing bot on its computer when the default changes", async () => {
    const cookie = await signup(app, `default-existing-${Date.now()}@rakazo.test`);
    const before = await create(cookie, "Before");
    const beforeComputer = await computerOf(before.id);
    process.env.COMPUTER_DEFAULT_MODE = "dedicated";
    await create(cookie, "After");
    expect((await computerOf(before.id))?.id).toBe(beforeComputer?.id);
    const listed = await rpc<Bot[]>(app, cookie, "bots/list");
    expect(listed.find((bot) => bot.id === before.id)?.computerMode).toBe("team");
  });
});

async function signup(app: App, email: string) {
  const response = await app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://127.0.0.1:5173" },
    body: JSON.stringify({ email, password: "test-password-123", name: "Computer User" }),
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
  const parsed = JSON.parse(await response.text()) as { json?: T; error?: { message?: string } };
  if (response.status >= 400 || parsed.error) {
    throw new Error(`${proc} ${response.status}: ${parsed.error?.message ?? "failed"}`);
  }
  return parsed.json as T;
}
