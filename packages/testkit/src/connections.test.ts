import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ComposioEmulator,
  EncryptedSecretStore,
  InstalledConnectorProvider,
  PipedreamConnector,
  ThirdPartyConnectorEmulator,
} from "@rakazo/adapters";
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
const TEST_ENCRYPTION_KEY = "offline-connector-test-encryption-key";

describeWithDatabase("Composio catalog reconciliation", () => {
  let handles: AppHandles;
  let app: App;
  let composio: ComposioEmulator;
  let thirdParties: ThirdPartyConnectorEmulator;
  let connectionOrdinal = 0;
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const dataDir = mkdtempSync(path.join(tmpdir(), "rakazo-connections-"));

  beforeAll(async () => {
    const { createApp } = await import("../../../apps/api/src/app.ts");
    composio = new ComposioEmulator();
    thirdParties = new ThirdPartyConnectorEmulator();
    const pipedream = new PipedreamConnector(
      {
        clientId: "fake-client-id",
        clientSecret: "fake-client-secret",
        projectId: "fake-project-id",
        environment: "development",
        identitySecret: TEST_ENCRYPTION_KEY,
      },
      { fetch: thirdParties.fetch, resolveHostname: thirdParties.resolveHostname },
    );
    handles = await createApp({
      databaseUrl: process.env.DATABASE_URL!,
      dataDir,
      sandboxProvider: "fake",
      agentRuntime: "scripted",
      composio,
      pipedream,
      remoteConnectors: {
        fetch: thirdParties.fetch,
        resolveHostname: thirdParties.resolveHostname,
      },
      encryptionKey: TEST_ENCRYPTION_KEY,
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

    await expect(
      rpc(app, cookie, "connections/catalog", { connectorId: "composio" }),
    ).resolves.toEqual([]);
    await expect(statuses([pending.id])).resolves.toEqual([{ id: pending.id, status: "pending" }]);
    failure.mockRestore();
  });

  it("routes an emulated Composio app tool with user-scoped connection context", async () => {
    const cookie = await signup(app, `composio-tool-${stamp}@rakazo.test`, "Composio Tool");
    const actor = await rpc<Actor>(app, cookie, "me");
    const started = await rpc<{ connectionId: string; authorizationUrl: null }>(
      app,
      cookie,
      "connections/begin",
      { connectorId: "composio", provider: "GMAIL", displayName: "Gmail" },
    );
    expect(started.authorizationUrl).toBeNull();
    const context = {
      operationId: "composio-product-test",
      traceId: "composio-product-test",
      workspaceId: actor.workspaceId,
      userId: actor.userId,
      signal: new AbortController().signal,
      connectedConnections: [
        {
          id: started.connectionId,
          connectorId: "composio",
          externalId: "GMAIL",
          displayName: "Gmail",
        },
      ],
    };
    const tool = (await handles.connectors.discoverTools(context)).find(
      (candidate) => candidate.route?.connectorId === "composio",
    );
    expect(tool).toMatchObject({ name: "GMAIL_EMULATED_ACTION" });
    const events = [];
    for await (const event of handles.connectors.execute(
      {
        tool: tool!.name,
        args: { value: "composio-product-ok" },
        executionId: "composio-product-execution",
        route: tool!.route,
      },
      context,
    )) {
      events.push(event);
    }
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "result",
        data: expect.objectContaining({ ok: true, tool: "GMAIL_EMULATED_ACTION" }),
      }),
    );
    expect(composio.executions).toContainEqual(
      expect.objectContaining({ userId: actor.userId, tool: "GMAIL_EMULATED_ACTION" }),
    );
  });

  it("runs Pipedream connection and MCP tool execution through the product registry", async () => {
    const cookie = await signup(app, `pipedream-${stamp}@rakazo.test`, "Pipedream Connector");
    const actor = await rpc<Actor>(app, cookie, "me");
    const catalog = await rpc<Array<{ connectorId: string; slug: string; connected: boolean }>>(
      app,
      cookie,
      "connections/catalog",
      { connectorId: "pipedream" },
    );
    expect(catalog).toContainEqual(
      expect.objectContaining({ connectorId: "pipedream", slug: "linear", connected: false }),
    );

    const started = await rpc<{ connectionId: string; authorizationUrl: string }>(
      app,
      cookie,
      "connections/begin",
      { connectorId: "pipedream", provider: "linear", displayName: "Linear" },
    );
    expect(started.authorizationUrl).toBe("about:blank?app=linear");
    await expect(
      rpc<{ status: string }>(app, cookie, "connections/complete", {
        connectionId: started.connectionId,
      }),
    ).resolves.toMatchObject({ status: "connected" });

    const context = {
      operationId: "pipedream-product-test",
      traceId: "pipedream-product-test",
      workspaceId: actor.workspaceId,
      userId: actor.userId,
      signal: new AbortController().signal,
      connectedConnections: [
        {
          id: started.connectionId,
          connectorId: "pipedream",
          externalId: "linear",
          displayName: "Linear",
        },
      ],
    };
    const tool = (await handles.connectors.discoverTools(context)).find(
      (candidate) => candidate.route?.connectorId === "pipedream",
    );
    expect(tool).toMatchObject({ name: "notes.write" });
    const events = [];
    for await (const event of handles.connectors.execute(
      {
        tool: tool!.name,
        args: { text: "product-pipedream-ok" },
        executionId: "pipedream-product-execution",
        route: tool!.route,
      },
      context,
    )) {
      events.push(event);
    }
    expect(events).toContainEqual(expect.objectContaining({ type: "result" }));

    await rpc(app, cookie, "connections/revoke", { connectionId: started.connectionId });
    await expect(
      rpc<Array<{ id: string; status: string }>>(app, cookie, "connections/list"),
    ).resolves.toContainEqual(
      expect.objectContaining({ id: started.connectionId, status: "revoked" }),
    );
  });

  it("installs Treg and custom MCP sources, discovers tools, and routes both calls", async () => {
    const cookie = await signup(app, `mcp-connectors-${stamp}@rakazo.test`, "MCP Connectors");
    const actor = await rpc<Actor>(app, cookie, "me");
    const tregCredential = "fake-treg-credential-value";
    const treg = await rpc<{ id: string; secretConfigured: boolean }>(
      app,
      cookie,
      "capabilities/install",
      {
        kind: "mcp",
        name: "Treg",
        source: "https://treg.to/mcp/",
        credential: tregCredential,
        config: { preset: "treg", auth: { type: "bearer" } },
      },
    );
    const custom = await rpc<{ id: string; secretConfigured: boolean }>(
      app,
      cookie,
      "capabilities/install",
      {
        kind: "mcp",
        name: "Custom MCP",
        source: "https://mcp.example.test/mcp",
        config: { preset: "custom", auth: { type: "none" } },
      },
    );
    expect(treg.secretConfigured).toBe(true);
    expect(custom.secretConfigured).toBe(false);
    expect(JSON.stringify(treg)).not.toContain(tregCredential);

    const provider = new InstalledConnectorProvider(
      handles.prisma,
      new EncryptedSecretStore(TEST_ENCRYPTION_KEY),
      { fetch: thirdParties.fetch, resolveHostname: thirdParties.resolveHostname },
    );
    const context = {
      operationId: "mcp-product-test",
      traceId: "mcp-product-test",
      workspaceId: actor.workspaceId,
      userId: actor.userId,
      signal: new AbortController().signal,
    };
    const tools = await provider.discoverTools(context);
    expect(tools.filter((tool) => tool.name === "notes.write")).toHaveLength(2);
    for (const install of [treg, custom]) {
      const tool = tools.find((candidate) => candidate.route?.resourceId === install.id);
      const events = [];
      for await (const event of provider.execute(
        {
          tool: tool!.name,
          args: { text: `mcp-${install.id}` },
          executionId: `mcp-${install.id}`,
          route: tool!.route,
        },
        context,
      )) {
        events.push(event);
      }
      expect(events).toContainEqual(expect.objectContaining({ type: "result" }));
    }
    expect(thirdParties.records).toContainEqual(
      expect.objectContaining({ provider: "mcp", operation: "notes.write", host: "treg.to" }),
    );
    expect(thirdParties.records).toContainEqual(
      expect.objectContaining({
        provider: "mcp",
        operation: "notes.write",
        host: "mcp.example.test",
      }),
    );
  });

  it("imports an OpenAPI connector, keeps its credential encrypted, and routes calls", async () => {
    const cookie = await signup(app, `api-connector-${stamp}@rakazo.test`, "API Connector");
    const actor = await rpc<Actor>(app, cookie, "me");
    const credential = "test-connector-secret-value";
    const install = await rpc<{
      id: string;
      config: Record<string, unknown>;
      secretConfigured: boolean;
    }>(app, cookie, "capabilities/install", {
      kind: "api",
      name: "CRM API",
      source: "https://api.example.test/openapi.json",
      credential,
      config: { openApi: true, auth: { type: "bearer" } },
    });
    expect(install.secretConfigured).toBe(true);
    expect(JSON.stringify(install)).not.toContain(credential);

    const storedInstall = await handles.prisma.capabilityInstall.findUniqueOrThrow({
      where: { id: install.id },
    });
    const storedSecret = await handles.prisma.secret.findUniqueOrThrow({
      where: { id: storedInstall.secretId! },
    });
    expect(storedSecret.ciphertext).not.toContain(credential);

    const provider = new InstalledConnectorProvider(
      handles.prisma,
      new EncryptedSecretStore(TEST_ENCRYPTION_KEY),
      { fetch: thirdParties.fetch, resolveHostname: thirdParties.resolveHostname },
    );
    const adapterContext = {
      operationId: "api-connector-test",
      traceId: "api-connector-test",
      workspaceId: actor.workspaceId,
      userId: actor.userId,
      signal: new AbortController().signal,
    };
    const tools = await provider.discoverTools(adapterContext);
    const tool = tools.find((candidate) => candidate.name === "getContact");
    expect(tool).toMatchObject({ readOnly: true });

    const events = [];
    for await (const event of provider.execute(
      {
        tool: "getContact",
        args: { contactId: "contact-1" },
        executionId: "api-call-1",
        route: tool!.route,
      },
      adapterContext,
    )) {
      events.push(event);
    }
    expect(JSON.stringify(events)).toContain("contact-1");
    expect(JSON.stringify(events)).not.toContain(credential);
    expect(thirdParties.records).toContainEqual(
      expect.objectContaining({
        provider: "openapi",
        path: "/v1/contacts/contact-1",
        authenticated: true,
      }),
    );

    await rpc(app, cookie, "capabilities/remove", { id: install.id });
    await expect(
      handles.prisma.secret.findUnique({ where: { id: storedSecret.id } }),
    ).resolves.toBeNull();
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
