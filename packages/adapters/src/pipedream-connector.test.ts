import type { AdapterContext } from "@rakazo/adapter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PipedreamConnector, pipedreamConfigFromEnv } from "./pipedream-connector.js";
import { ThirdPartyConnectorEmulator } from "./third-party-connector-emulator.js";

const context: AdapterContext = {
  operationId: "pipedream-test",
  traceId: "pipedream-test",
  workspaceId: "workspace-example",
  userId: "user-example",
  signal: new AbortController().signal,
};

describe("pipedreamConfigFromEnv", () => {
  it("maps shared environment values and normalizes unsupported environments", () => {
    expect(
      pipedreamConfigFromEnv({
        pipedreamClientId: "client-id",
        pipedreamClientSecret: "client-secret",
        pipedreamProjectId: "project-id",
        pipedreamEnvironment: "staging",
        encryptionKey: "identity-secret",
      }),
    ).toEqual({
      clientId: "client-id",
      clientSecret: "client-secret",
      projectId: "project-id",
      environment: "development",
      identitySecret: "identity-secret",
    });
  });
});

describe("PipedreamConnector", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses one opaque external identity across the app catalog and account flow", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        requests.push({ url, init });
        if (url.endsWith("/v1/oauth/token")) {
          return Response.json({ access_token: "fake-access-token", expires_in: 3_600 });
        }
        if (url.includes("/v1/connect/apps?")) {
          return Response.json({
            data: [{ id: "app-1", name_slug: "gmail", name: "Gmail" }],
            page_info: {},
          });
        }
        if (url.includes("/accounts?")) {
          return Response.json({
            data: [
              {
                id: "account-1",
                healthy: true,
                app: { id: "app-1", name_slug: "gmail", name: "Gmail" },
              },
            ],
            page_info: {},
          });
        }
        if (url.endsWith("/tokens")) {
          return Response.json({ connect_link_url: "https://pipedream.example.test/connect" });
        }
        throw new Error(`Unexpected request ${url}`);
      }),
    );
    const connector = new PipedreamConnector({
      clientId: "fake-client-id",
      clientSecret: "fake-client-secret",
      projectId: "fake-project-id",
      environment: "development",
      identitySecret: "fake-identity-secret",
    });

    await expect(connector.catalog(context)).resolves.toEqual([
      expect.objectContaining({
        connectorId: "pipedream",
        slug: "gmail",
        connected: true,
      }),
    ]);
    const started = await connector.begin(
      { provider: "gmail", redirectUrl: "https://rakazo.example.test/app" },
      context,
    );

    expect(started.authorizationUrl).toBe("https://pipedream.example.test/connect?app=gmail");
    expect(requests.filter((request) => request.url.endsWith("/v1/oauth/token"))).toHaveLength(1);
    expect(
      requests.find((request) => request.url.endsWith("/v1/oauth/token"))?.init?.body,
    ).toContain('"scope":"connect:*"');
    const accountUrl = requests.find((request) => request.url.includes("/accounts?"))?.url;
    const connectRequest = requests.find((request) => request.url.endsWith("/tokens"));
    const externalId = new URL(accountUrl!).searchParams.get("external_user_id");
    expect(externalId).toMatch(/^rkz_[a-f0-9]{64}$/);
    expect(externalId).not.toContain(context.userId);
    expect(externalId).not.toContain(context.workspaceId);
    expect(JSON.parse(String(connectRequest?.init?.body))).toEqual(
      expect.objectContaining({ external_user_id: externalId }),
    );
  });

  it("runs catalog, connection, discovery, execution, and revoke against the protocol emulator", async () => {
    const emulator = new ThirdPartyConnectorEmulator();
    const connector = new PipedreamConnector(
      {
        clientId: "fake-client-id",
        clientSecret: "fake-client-secret",
        projectId: "fake-project-id",
        environment: "development",
        identitySecret: "fake-identity-secret",
      },
      { fetch: emulator.fetch, resolveHostname: emulator.resolveHostname },
    );

    await expect(connector.catalog(context)).resolves.toContainEqual(
      expect.objectContaining({ connectorId: "pipedream", slug: "linear", connected: false }),
    );
    await expect(
      connector.begin(
        { provider: "linear", redirectUrl: "https://rakazo.example.test/app" },
        context,
      ),
    ).resolves.toEqual({ authorizationUrl: "about:blank?app=linear", state: "linear" });
    await expect(connector.connectionReady(context, "linear")).resolves.toBe(true);

    const connectedContext = {
      ...context,
      connectedConnections: [
        {
          id: "connection-linear",
          connectorId: "pipedream",
          externalId: "linear",
          displayName: "Linear",
        },
      ],
    };
    const tools = await connector.discoverTools(connectedContext);
    expect(tools).toContainEqual(
      expect.objectContaining({
        name: "notes.write",
        route: expect.objectContaining({ connectorId: "pipedream", resourceId: "linear" }),
      }),
    );
    const events = [];
    for await (const event of connector.execute(
      {
        tool: "notes.write",
        args: { text: "emulated-pipedream-ok" },
        executionId: "pipedream-emulated-execution",
        route: tools[0]?.route,
      },
      connectedContext,
    )) {
      events.push(event);
    }
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "result",
        data: expect.objectContaining({ isError: false }),
      }),
    );
    expect(emulator.records).toContainEqual(
      expect.objectContaining({
        provider: "mcp",
        operation: "notes.write",
        args: { text: "emulated-pipedream-ok" },
      }),
    );

    await connector.revoke("linear", context);
    await expect(connector.connectionReady(context, "linear")).resolves.toBe(false);
  });
});
