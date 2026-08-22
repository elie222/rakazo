import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ComposioEmulator } from "@rakazo/adapters";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { sessionCookieHeader } from "./index.js";

type App = { request: (input: string, init?: RequestInit) => Promise<Response> };
type AppHandles = Awaited<ReturnType<typeof import("../../../apps/api/src/app.ts").createApp>>;
type Actor = { workspaceId: string; userId: string };

process.env.WAKEUP_DRIVER = "memory";
process.env.SANDBOX_PROVIDER = "fake";
process.env.AGENT_RUNTIME = "scripted";

const hasDb = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const describeWithDatabase = hasDb ? describe : describe.skip;

describeWithDatabase("Composio catalog reconciliation", () => {
  let handles: AppHandles;
  let app: App;
  let composio: ComposioEmulator;
  let connectionOrdinal = 0;
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const dataDir = mkdtempSync(path.join(tmpdir(), "rakazo-connections-"));

  beforeAll(async () => {
    const { createApp } = await import("../../../apps/api/src/app.ts");
    composio = new ComposioEmulator();
    handles = await createApp({
      databaseUrl: process.env.DATABASE_URL!,
      dataDir,
      sandboxProvider: "fake",
      agentRuntime: "scripted",
      composio,
      signupsEnabled: "true",
    });
    app = handles.app;
  });

  afterAll(async () => {
    await handles?.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reconciles one scoped row per provider under concurrent catalog fetches", async () => {
    const ownerCookie = await signup(app, `owner-connections-${stamp}@rakazo.test`, "Owner");
    const otherCookie = await signup(app, `other-connections-${stamp}@rakazo.test`, "Other");
    const owner = await rpc<Actor>(app, ownerCookie, "me");
    const other = await rpc<Actor>(app, otherCookie, "me");
    await connectRemote(composio, owner, "GMAIL");

    const first = await createConnection(owner, "GMAIL");
    const duplicate = await createConnection(owner, "GMAIL");
    const otherProvider = await createConnection(owner, "SLACK");
    const otherUser = await createConnection(
      { workspaceId: owner.workspaceId, userId: other.userId },
      "GMAIL",
    );
    const otherWorkspace = await createConnection(
      { workspaceId: other.workspaceId, userId: owner.userId },
      "GMAIL",
    );

    const catalogs = await Promise.all(
      Array.from({ length: 4 }, () =>
        rpc<Array<{ slug: string; connected: boolean }>>(app, ownerCookie, "connections/catalog"),
      ),
    );
    for (const catalog of catalogs) {
      expect(catalog).toContainEqual(expect.objectContaining({ slug: "GMAIL", connected: true }));
    }

    await expect(statuses([first.id, duplicate.id])).resolves.toEqual([
      { id: first.id, status: "connected" },
      { id: duplicate.id, status: "revoked" },
    ]);
    await expect(statuses([otherProvider.id, otherUser.id, otherWorkspace.id])).resolves.toEqual([
      { id: otherProvider.id, status: "pending" },
      { id: otherUser.id, status: "pending" },
      { id: otherWorkspace.id, status: "pending" },
    ]);

    await rpc(app, ownerCookie, "connections/catalog");
    await expect(statuses([first.id, duplicate.id])).resolves.toEqual([
      { id: first.id, status: "connected" },
      { id: duplicate.id, status: "revoked" },
    ]);
  });

  it("returns the remote catalog when local reconciliation fails", async () => {
    const cookie = await signup(app, `db-failure-connections-${stamp}@rakazo.test`, "DB Failure");
    const actor = await rpc<Actor>(app, cookie, "me");
    await connectRemote(composio, actor, "SLACK");
    const pending = await createConnection(actor, "SLACK");
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const failure = vi
      .spyOn(handles.prisma.connection, "findMany")
      .mockRejectedValueOnce(new Error("simulated reconciliation failure"));

    const catalog = await rpc<Array<{ slug: string; connected: boolean }>>(
      app,
      cookie,
      "connections/catalog",
    );

    expect(catalog).toContainEqual(expect.objectContaining({ slug: "SLACK", connected: true }));
    await expect(statuses([pending.id])).resolves.toEqual([{ id: pending.id, status: "pending" }]);
    expect(log).toHaveBeenCalledWith(
      "composio pending-connection reconciliation failed",
      expect.any(Error),
    );
    failure.mockRestore();
    log.mockRestore();
  });

  it("does not mutate local state when the provider catalog fails", async () => {
    const cookie = await signup(
      app,
      `provider-failure-connections-${stamp}@rakazo.test`,
      "Provider Failure",
    );
    const actor = await rpc<Actor>(app, cookie, "me");
    const pending = await createConnection(actor, "GITHUB");
    const failure = vi
      .spyOn(composio, "catalog")
      .mockRejectedValueOnce(new Error("simulated provider failure"));

    await expect(rpc(app, cookie, "connections/catalog")).resolves.toEqual([]);
    await expect(statuses([pending.id])).resolves.toEqual([{ id: pending.id, status: "pending" }]);
    failure.mockRestore();
  });

  async function createConnection(owner: Actor, provider: string) {
    return handles.prisma.connection.create({
      data: {
        workspaceId: owner.workspaceId,
        userId: owner.userId,
        provider,
        displayName: provider,
        status: "pending",
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, connectionOrdinal++)),
      },
    });
  }

  async function statuses(ids: string[]) {
    return handles.prisma.connection.findMany({
      where: { id: { in: ids } },
      select: { id: true, status: true },
      orderBy: { createdAt: "asc" },
    });
  }
});

async function connectRemote(composio: ComposioEmulator, actor: Actor, provider: string) {
  await composio.begin(
    { provider, redirectUrl: "http://127.0.0.1.invalid/callback" },
    {
      operationId: "connections-test",
      traceId: "connections-test",
      workspaceId: actor.workspaceId,
      userId: actor.userId,
      signal: new AbortController().signal,
    },
  );
}

async function signup(app: App, email: string, name: string) {
  const response = await app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "http://127.0.0.1:5173",
    },
    body: JSON.stringify({ email, password: "password12", name }),
  });
  if (!response.ok) throw new Error(`signup failed ${response.status}: ${await response.text()}`);
  return sessionCookieHeader(response);
}

async function rpc<T>(app: App, cookie: string, procedure: string, body: unknown = {}): Promise<T> {
  const response = await app.request(`/rpc/${procedure}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie,
      origin: "http://127.0.0.1:5173",
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
