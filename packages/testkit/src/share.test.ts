import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Bot, ExportManifest, ShareManifest } from "@rakazo/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sessionCookieHeader } from "./index.js";

type App = { request: (input: string, init?: RequestInit) => Promise<Response> };
type AppHandles = Awaited<ReturnType<typeof import("../../../apps/api/src/app.ts").createApp>>;

process.env.WAKEUP_DRIVER = "memory";
process.env.SANDBOX_PROVIDER = "fake";
process.env.AGENT_RUNTIME = "scripted";

const hasDb = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const describeShare = hasDb ? describe : describe.skip;

describeShare("bot share import and links", () => {
  let handles: AppHandles;
  let app: App;
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const dataDir = mkdtempSync(path.join(tmpdir(), "rakazo-share-"));

  beforeAll(async () => {
    const { createApp } = await import("../../../apps/api/src/app.ts");
    handles = await createApp({
      databaseUrl: process.env.DATABASE_URL!,
      dataDir,
      sandboxProvider: "fake",
      agentRuntime: "scripted",
      wakeupDriver: "memory",
      signupsEnabled: "true",
    });
    app = handles.app;
  });

  afterAll(async () => {
    await handles?.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("round-trips share config and rejects full export backups", async () => {
    const owner = await signup(app, `share-owner-${stamp}@rakazo.test`, "Share Owner");
    const source = await rpc<Bot>(app, owner, "bots/create", botInput("Source Bot"));
    await rpc(app, owner, "bots/update", {
      botId: source.id,
      title: "Helper",
      description: "Does helper work",
      instructions: "Be helpful",
      color: "#2965EC",
    });
    await rpc(app, owner, "routines/create", {
      botId: source.id,
      name: "Morning",
      prompt: "Check tasks",
      crons: ["0 9 * * *"],
      timezone: "UTC",
      notify: true,
      active: false,
    });

    const manifest = await rpc<ShareManifest>(app, owner, "bots/shareManifest", {
      botId: source.id,
    });
    expect(manifest.version).toBe("rakazo.share/v1");
    expect(manifest.name).toBe("Source Bot");
    expect(manifest.routines).toHaveLength(1);
    expect(manifest).not.toHaveProperty("history");
    expect(manifest).not.toHaveProperty("files");

    const imported = await rpc<Bot>(app, owner, "bots/importShare", { manifest });
    expect(imported.id).not.toBe(source.id);
    expect(imported.name).toBe("Source Bot");
    expect(imported.computerMode).toBe(source.computerMode);

    const sourceAfter = await rpc<Bot>(app, owner, "bots/get", { botId: source.id });
    expect(imported.computerMode).toBe(sourceAfter.computerMode);

    const importedRoutines = await rpc<Array<{ name: string }>>(app, owner, "routines/list", {
      botId: imported.id,
    });
    expect(importedRoutines.map((row) => row.name)).toEqual(["Morning"]);

    const mcpAssignments = await handles.prisma.botMcpServer.count({
      where: { botId: imported.id },
    });
    expect(mcpAssignments).toBe(0);

    const exportManifest = await rpc<ExportManifest>(app, owner, "export/bot", {
      botId: source.id,
    });
    const rejected = await raw(app, owner, "bots/importShare", { manifest: exportManifest });
    expect(rejected.status).toBeGreaterThanOrEqual(400);
  });

  it("rejects share manifests with invalid routine schedules", async () => {
    const owner = await signup(app, `share-cron-${stamp}@rakazo.test`, "Cron Owner");
    const manifest = await rpc<ShareManifest>(app, owner, "bots/shareManifest", {
      botId: (await rpc<Bot>(app, owner, "bots/create", botInput("Cron Bot"))).id,
    });
    const invalid = {
      ...manifest,
      routines: [{ name: "Bad", prompt: "Nope", crons: ["not-a-cron"], timezone: "UTC" }],
    };
    const response = await raw(app, owner, "bots/importShare", { manifest: invalid });
    expect(response.status).toBeGreaterThanOrEqual(400);
  });

  it("creates public preview links without leaking revoked or expired snapshots", async () => {
    const owner = await signup(app, `share-link-${stamp}@rakazo.test`, "Link Owner");
    const importer = await signup(app, `share-importer-${stamp}@rakazo.test`, "Importer");
    const source = await rpc<Bot>(app, owner, "bots/create", botInput("Link Bot"));

    const created = await rpc<{ token: string; url: string; expiresAt: string }>(
      app,
      owner,
      "bots/shareCreate",
      { botId: source.id },
    );
    expect(created.url).toContain(`/share/${created.token}`);

    const preview = await rpc<ShareManifest>(app, "", "share/preview", { token: created.token });
    expect(preview.name).toBe("Link Bot");
    expect(preview).not.toHaveProperty("history");
    expect(preview).not.toHaveProperty("files");
    expect(preview).not.toHaveProperty("memory");

    const imported = await rpc<Bot>(app, importer, "bots/importShare", { token: created.token });
    const importerMe = await rpc<{ userId: string }>(app, importer, "me");
    const ownerMe = await rpc<{ userId: string }>(app, owner, "me");
    expect(importerMe.userId).not.toBe(ownerMe.userId);
    expect(imported.id).not.toBe(source.id);

    const sourceRow = await handles.prisma.bot.findUniqueOrThrow({ where: { id: source.id } });
    const importedRow = await handles.prisma.bot.findUniqueOrThrow({ where: { id: imported.id } });
    expect(importedRow.computerId).not.toBe(sourceRow.computerId);

    await rpc(app, owner, "bots/shareRevoke", { token: created.token });
    const revoked = await raw(app, "", "share/preview", { token: created.token });
    expect(revoked.status).toBeGreaterThanOrEqual(400);

    const expiredToken = "expired-share-token-for-test";
    await handles.prisma.botShare.create({
      data: {
        token: expiredToken,
        workspaceId: (await rpc<{ workspaceId: string }>(app, owner, "me")).workspaceId,
        createdByUserId: (await rpc<{ userId: string }>(app, owner, "me")).userId,
        snapshot: preview,
        expiresAt: new Date(Date.now() - 60_000),
      },
    });
    const expired = await raw(app, "", "share/preview", { token: expiredToken });
    expect(expired.status).toBeGreaterThanOrEqual(400);
  });

  it("blocks sharing another user's bot", async () => {
    const owner = await signup(app, `share-iso-owner-${stamp}@rakazo.test`, "Iso Owner");
    const intruder = await signup(app, `share-iso-${stamp}@rakazo.test`, "Iso Intruder");
    const ownerBot = await rpc<Bot>(app, owner, "bots/create", botInput("Private Bot"));

    await expectDenied(app, intruder, "bots/shareManifest", { botId: ownerBot.id });
    await expectDenied(app, intruder, "bots/shareCreate", { botId: ownerBot.id });
    const manifest = await rpc<ShareManifest>(app, owner, "bots/shareManifest", {
      botId: ownerBot.id,
    });
    await expectDenied(app, intruder, "bots/shareCreate", { botId: ownerBot.id });
    await expectDenied(app, intruder, "bots/shareRevoke", { token: "not-a-real-token" });
    expect(manifest.name).toBe("Private Bot");
  });
});

function botInput(name: string) {
  return {
    name,
    title: "",
    description: "",
    instructions: "",
    notifyOnFinish: false,
  };
}

async function signup(app: App, email: string, name: string) {
  const response = await app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://127.0.0.1:5173" },
    body: JSON.stringify({ email, password: "password12", name }),
  });
  if (response.status >= 400) {
    throw new Error(`signup failed ${response.status}: ${await response.text()}`);
  }
  return sessionCookieHeader(response);
}

async function raw(app: App, cookie: string, procedure: string, body: unknown = {}) {
  return app.request(`/rpc/${procedure}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
      origin: "http://127.0.0.1:5173",
    },
    body: JSON.stringify({ json: body ?? {} }),
  });
}

async function rpc<T>(app: App, cookie: string, procedure: string, body: unknown = {}): Promise<T> {
  const response = await raw(app, cookie, procedure, body);
  const text = await response.text();
  const payload = JSON.parse(text) as { json?: T; error?: { message?: string } };
  if (response.status >= 400 || payload.error) {
    throw new Error(`${procedure} ${response.status}: ${payload.error?.message ?? text}`);
  }
  return payload.json as T;
}

async function expectDenied(app: App, cookie: string, procedure: string, body: unknown) {
  const response = await raw(app, cookie, procedure, body);
  expect(response.status, procedure).toBeGreaterThanOrEqual(400);
}
