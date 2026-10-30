import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Bot } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import {
  BotRuntimeProfileConflictError,
  readBotRuntimeProfile,
  runAsTenant,
  writeBotRuntimeProfile,
} from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sessionCookieHeader } from "./index.js";
import { asSystem } from "./system-db.js";

type App = { request: (input: string, init?: RequestInit) => Response | Promise<Response> };
const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const describePostgres = enabled ? describe.sequential : describe.skip;

describePostgres("bot runtime profiles (PostgreSQL)", () => {
  let app: App;
  let db: PrismaClient;
  let runtimeDb: PrismaClient;
  let stop: () => Promise<void>;
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const dataDir = mkdtempSync(path.join(tmpdir(), "rakazo-profile-test-"));
  const bots: string[] = [];
  const users: string[] = [];

  beforeAll(async () => {
    const { createApp } = await import("@rakazo/api/app");
    const handles = await createApp({
      databaseUrl: process.env.DATABASE_URL!,
      dataDir,
      sandboxProvider: "fake",
      agentRuntime: "scripted",
      wakeupDriver: "memory",
    });
    app = handles.app;
    runtimeDb = handles.prisma;
    db = asSystem(runtimeDb);
    stop = handles.stop;
  });

  afterAll(async () => {
    if (bots.length) await db.bot.deleteMany({ where: { id: { in: bots } } });
    if (users.length) await db.user.deleteMany({ where: { id: { in: users } } });
    await stop?.();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("uses authenticated RPC revisions and keeps persona separate from instructions", async () => {
    const ownerCookie = await signup(app, `profile-api-owner-${stamp}@rakazo.test`, "Owner");
    const otherCookie = await signup(app, `profile-api-other-${stamp}@rakazo.test`, "Other");
    const owner = await rpc<{ userId: string }>(app, ownerCookie, "me");
    const other = await rpc<{ userId: string }>(app, otherCookie, "me");
    users.push(owner.userId, other.userId);

    const bot = await rpc<Bot>(app, ownerCookie, "bots/create", {
      name: "Profile API test",
      description: "",
      instructions: "Base bot instructions stay unchanged.",
      notifyOnFinish: true,
    });
    bots.push(bot.id);
    const settings = { persona: { persona: "A concise, careful assistant." } };
    const initial = await rpc<{
      revision: number;
      settings: typeof settings;
      activationStatus: string;
    }>(app, ownerCookie, "bots/runtimeProfileGet", { botId: bot.id });
    expect(initial.revision).toBe(0);
    expect(initial.settings.persona.persona).toBe("");

    const updated = await rpc<typeof initial>(app, ownerCookie, "bots/runtimeProfileUpdate", {
      botId: bot.id,
      expectedRevision: 0,
      settings,
      reason: "Set persona",
    });
    expect(updated.revision).toBe(1);
    expect(updated.settings.persona.persona).toBe(settings.persona.persona);
    expect((await rpc<Bot>(app, ownerCookie, "bots/get", { botId: bot.id })).instructions).toBe(
      "Base bot instructions stay unchanged.",
    );

    await expect(
      rpc(app, ownerCookie, "bots/runtimeProfileUpdate", {
        botId: bot.id,
        expectedRevision: 1,
        settings: { skills: { mode: "explicit", skillIds: ["skill-one"] } },
        reason: "Enable explicit skills",
      }),
    ).rejects.toThrow();
    await expect(
      rpc(app, otherCookie, "bots/runtimeProfileGet", { botId: bot.id }),
    ).rejects.toThrow();

    const { runId } = await rpc<{ runId: string }>(app, ownerCookie, "threads/send", {
      botId: bot.id,
      text: "Confirm the persona snapshot.",
    });
    const run = await waitForRun(db, runId);
    expect(run.runtimeProfileSnapshot).toMatchObject({
      revision: 1,
      settings: { persona: { persona: settings.persona.persona } },
    });
    expect(run.status).toBe("completed");
    const secondRevision = await rpc<typeof initial>(
      app,
      ownerCookie,
      "bots/runtimeProfileUpdate",
      {
        botId: bot.id,
        expectedRevision: 1,
        settings: { persona: { persona: "A later persona." } },
        reason: "Update persona after the run",
      },
    );
    expect(secondRevision.revision).toBe(2);
    const persistedRun = await db.run.findUniqueOrThrow({
      where: { id: runId },
      select: { runtimeProfileSnapshot: true },
    });
    expect(persistedRun.runtimeProfileSnapshot).toEqual(run.runtimeProfileSnapshot);
  });

  it("isolates ownership, serializes first creation, preserves snapshots, and cascades", async () => {
    const ownerCookie = await signup(app, `profile-owner-${stamp}@rakazo.test`, "Owner");
    const otherCookie = await signup(app, `profile-other-${stamp}@rakazo.test`, "Other");
    const owner = await rpc<{ userId: string }>(app, ownerCookie, "me");
    const other = await rpc<{ userId: string }>(app, otherCookie, "me");
    users.push(owner.userId, other.userId);

    const bot = await rpc<Bot>(app, ownerCookie, "bots/create", {
      name: "Profile test",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    bots.push(bot.id);
    const scope = await db.bot.findUniqueOrThrow({
      where: { id: bot.id },
      select: { id: true, spaceId: true, userId: true },
    });
    const write = (settings: { label: string }, expectedRevision: number, userId = scope.userId) =>
      writeBotRuntimeProfile(db, {
        botId: scope.id,
        spaceId: scope.spaceId,
        userId,
        expectedRevision,
        settings,
        reason: `Write ${settings.label}`,
      });

    await expect(
      readBotRuntimeProfile(db, { botId: scope.id, spaceId: scope.spaceId, userId: other.userId }),
    ).rejects.toThrow();
    await expect(write({ label: "unauthorized" }, 0, other.userId)).rejects.toThrow();
    const results = await Promise.allSettled([
      write({ label: "first" }, 0),
      write({ label: "second" }, 0),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({ reason: expect.any(BotRuntimeProfileConflictError) });

    const profile = await db.botRuntimeProfile.findUniqueOrThrow({ where: { botId: scope.id } });
    const firstSnapshot = await db.botRuntimeProfileRevision.findUniqueOrThrow({
      where: { botId_revision: { botId: scope.id, revision: 1 } },
    });
    expect(profile.revision).toBe(1);
    expect(firstSnapshot.settings).toEqual(profile.settings);
    await expect(
      runAsTenant({ spaceId: scope.spaceId, userId: other.userId }, () =>
        runtimeDb.botRuntimeProfile.findMany({ where: { botId: scope.id } }),
      ),
    ).resolves.toHaveLength(0);

    const nextSettings = { label: "next" };
    await writeBotRuntimeProfile(db, {
      botId: scope.id,
      spaceId: scope.spaceId,
      userId: scope.userId,
      expectedRevision: 1,
      settings: nextSettings,
      reason: "Second revision",
    });
    const retainedSnapshot = await db.botRuntimeProfileRevision.findUniqueOrThrow({
      where: { botId_revision: { botId: scope.id, revision: 1 } },
    });
    expect(retainedSnapshot.settings).toEqual(firstSnapshot.settings);
    expect(await db.botRuntimeProfileRevision.count({ where: { botId: scope.id } })).toBe(2);

    await db.bot.delete({ where: { id: scope.id } });
    bots.splice(bots.indexOf(scope.id), 1);
    expect(await db.botRuntimeProfile.findUnique({ where: { botId: scope.id } })).toBeNull();
    expect(await db.botRuntimeProfileRevision.count({ where: { botId: scope.id } })).toBe(0);
  });
});

async function waitForRun(db: PrismaClient, runId: string) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const run = await db.run.findUnique({
      where: { id: runId },
      select: { status: true, runtimeProfileSnapshot: true },
    });
    if (run && ["completed", "failed", "cancelled"].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Run ${runId} did not finish within 15 seconds`);
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

async function rpc<T>(app: App, cookie: string, procedure: string, body: unknown = {}): Promise<T> {
  const response = await app.request(`/rpc/${procedure}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://127.0.0.1:5173", cookie },
    body: JSON.stringify({ json: body }),
  });
  const result = (await response.json()) as { json?: T; error?: { message?: string } };
  if (!response.ok || result.error)
    throw new Error(`${procedure}: ${result.error?.message ?? response.status}`);
  return result.json as T;
}
