import type { AdapterContext } from "@rakazo/adapter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isPipedreamEnabled,
  MAX_PIPEDREAM_RESPONSE_BYTES,
  PipedreamConnector,
  pipedreamConfigFromEnv,
} from "./pipedream-connector.js";
import { ThirdPartyConnectorEmulator } from "./third-party-connector-emulator.js";

const context: AdapterContext = {
  operationId: "pipedream-test",
  traceId: "pipedream-test",
  spaceId: "workspace-example",
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

  it.each(["0", "false"])("does not treat VITEST=%s as an active test runner", (value) => {
    vi.stubEnv("VITEST", value);
    expect(
      isPipedreamEnabled({
        clientId: "client-id",
        clientSecret: "client-secret",
        projectId: "project-id",
        environment: "production",
        identitySecret: "identity-secret",
      }),
    ).toBe(true);
    vi.unstubAllEnvs();
  });
});

describe("PipedreamConnector", () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    "javascript:alert(document.domain)",
    "http://pipedream.example.test/connect",
    "https://user:password@pipedream.example.test/connect",
  ])("rejects an unsafe provider connect URL: %s", async (connectUrl) => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ access_token: "fake-access-token", expires_in: 3_600 }),
      )
      .mockResolvedValueOnce(Response.json({ connect_link_url: connectUrl }));
    const connector = new PipedreamConnector(
      {
        clientId: "fake-client-id",
        clientSecret: "fake-client-secret",
        projectId: "fake-project-id",
        environment: "development",
        identitySecret: "fake-identity-secret",
      },
      { fetch },
    );

    await expect(
      connector.begin(
        { provider: "gmail", redirectUrl: "https://rakazo.example.test/app" },
        context,
      ),
    ).rejects.toThrow("secure HTTPS connect URL");
  });

  it("rejects an oversized token response before buffering it", async () => {
    const response = new Response("oversized", {
      headers: { "content-length": String(MAX_PIPEDREAM_RESPONSE_BYTES + 1) },
    });
    const cancel = vi.spyOn(response.body!, "cancel");
    const connector = new PipedreamConnector(
      {
        clientId: "fake-client-id",
        clientSecret: "fake-client-secret",
        projectId: "fake-project-id",
        environment: "development",
        identitySecret: "fake-identity-secret",
      },
      { fetch: vi.fn().mockResolvedValue(response) },
    );

    await expect(
      connector.begin(
        { provider: "gmail", redirectUrl: "https://rakazo.example.test/app" },
        context,
      ),
    ).rejects.toThrow("Pipedream response is too large.");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("rejects oversized Content-Length without waiting on a hanging body cancel", async () => {
    let cancelStarted = false;
    const hangingBody = new ReadableStream<Uint8Array>({
      start() {
        // never enqueues or closes
      },
      cancel() {
        cancelStarted = true;
        return new Promise(() => {
          // never settles
        });
      },
    });
    const abort = new AbortController();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ access_token: "fake-access-token", expires_in: 3_600 }),
      )
      .mockImplementationOnce(async () => {
        setTimeout(() => abort.abort(), 20);
        return new Response(hangingBody, {
          headers: { "content-length": String(MAX_PIPEDREAM_RESPONSE_BYTES + 1) },
        });
      });
    const connector = new PipedreamConnector(
      {
        clientId: "fake-client-id",
        clientSecret: "fake-client-secret",
        projectId: "fake-project-id",
        environment: "development",
        identitySecret: "fake-identity-secret",
      },
      { fetch },
    );

    const started = Date.now();
    await expect(
      connector.begin(
        { provider: "gmail", redirectUrl: "https://rakazo.example.test/app" },
        { ...context, signal: abort.signal },
      ),
    ).rejects.toThrow("Pipedream response is too large.");
    expect(cancelStarted).toBe(true);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("caps a chunked API response without a content length", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ access_token: "fake-access-token", expires_in: 3_600 }),
      )
      .mockResolvedValueOnce(new Response(new Uint8Array(MAX_PIPEDREAM_RESPONSE_BYTES + 1)));
    const connector = new PipedreamConnector(
      {
        clientId: "fake-client-id",
        clientSecret: "fake-client-secret",
        projectId: "fake-project-id",
        environment: "development",
        identitySecret: "fake-identity-secret",
      },
      { fetch },
    );

    await expect(
      connector.begin(
        { provider: "gmail", redirectUrl: "https://rakazo.example.test/app" },
        context,
      ),
    ).rejects.toThrow("Pipedream response is too large.");
  });

  it("clears a rejected token before reading an oversized 401 response", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ access_token: "rejected-token", expires_in: 3_600 }))
      .mockResolvedValueOnce(
        new Response("oversized", {
          status: 401,
          headers: { "content-length": String(MAX_PIPEDREAM_RESPONSE_BYTES + 1) },
        }),
      )
      .mockResolvedValueOnce(
        Response.json({ access_token: "replacement-token", expires_in: 3_600 }),
      )
      .mockResolvedValueOnce(
        Response.json({ connect_link_url: "https://pipedream.example.test/connect" }),
      );
    const connector = new PipedreamConnector(
      {
        clientId: "fake-client-id",
        clientSecret: "fake-client-secret",
        projectId: "fake-project-id",
        environment: "development",
        identitySecret: "fake-identity-secret",
      },
      { fetch },
    );

    await expect(
      connector.begin(
        { provider: "gmail", redirectUrl: "https://rakazo.example.test/app" },
        context,
      ),
    ).rejects.toThrow("Pipedream response is too large.");
    await expect(
      connector.begin(
        { provider: "gmail", redirectUrl: "https://rakazo.example.test/app" },
        context,
      ),
    ).resolves.toEqual({
      authorizationUrl: "https://pipedream.example.test/connect?app=gmail",
      state: "gmail",
    });
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(fetch.mock.calls[3]?.[1]?.headers).toEqual(
      expect.objectContaining({ authorization: "Bearer replacement-token" }),
    );
  });

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
    expect(externalId).not.toContain(context.spaceId);
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
    ).resolves.toEqual({
      authorizationUrl: "https://pipedream.example.test/connect?app=linear",
      state: "linear",
    });
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
