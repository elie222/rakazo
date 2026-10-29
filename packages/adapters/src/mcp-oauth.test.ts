import { MCP_OAUTH_CLIENT_REQUIRED } from "@rakazo/contracts";
import { getLogger } from "@rakazo/logging";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OAuthMaterial } from "./mcp-oauth.js";
import {
  McpOAuthBroker,
  McpOAuthClientRequiredError,
  McpReauthorizationRequiredError,
  oauthMaterialSecrets,
  StoredMcpOAuthProvider,
} from "./mcp-oauth.js";
import { McpSession } from "./mcp-transport.js";

afterEach(() => vi.unstubAllGlobals());

const TEST_NETWORK = {
  // Read the global per call so a fetch stubbed after construction still wins.
  fetch: (input: string | URL | Request, init?: RequestInit) => globalThis.fetch(input, init),
  resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }],
};

function logicalHref(input: string | URL | Request, init?: RequestInit): string {
  const url = new URL(
    typeof input === "string" || input instanceof URL ? String(input) : input.url,
  );
  const host = new Headers(input instanceof Request ? input.headers : init?.headers).get("host");
  if (host) url.host = host;
  return url.href;
}

function deploymentOwner(ownerUserId: string) {
  return { findUnique: vi.fn(async () => ({ ownerUserId })) };
}

function oauthSessionStore() {
  return {
    count: vi.fn().mockResolvedValue(0),
    findFirst: vi.fn(),
    create: vi.fn().mockResolvedValue({}),
    deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
  };
}

function trackedClone(response: Response): { response: Response; bytesRead: () => number } {
  let bytes = 0;
  const clone = response.clone.bind(response);
  response.clone = () => {
    const cloned = clone();
    const reader = cloned.body?.getReader();
    if (!reader) return cloned;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const next = await reader.read();
        if (next.done) {
          controller.close();
          return;
        }
        bytes += next.value.byteLength;
        controller.enqueue(next.value);
      },
      cancel(reason) {
        return reader.cancel(reason);
      },
    });
    return new Response(body, {
      status: cloned.status,
      statusText: cloned.statusText,
      headers: cloned.headers,
    });
  };
  return { response, bytesRead: () => bytes };
}

function chunkedBody(totalBytes: number, chunkBytes: number): ReadableStream<Uint8Array> {
  let sent = 0;
  return new ReadableStream({
    pull(controller) {
      if (sent >= totalBytes) {
        controller.close();
        return;
      }
      const size = Math.min(chunkBytes, totalBytes - sent);
      sent += size;
      controller.enqueue(new Uint8Array(size).fill(0x61));
    },
  });
}

async function rejectedOAuthBegin(
  register: (() => Response | Promise<Response>) | null,
  secret?: string,
): Promise<Error> {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = logicalHref(input, init);
      if (url === "https://mcp.example.test/mcp" && request.method === "POST") {
        return new Response("missing bearer token", {
          status: 401,
          headers: {
            "content-type": "text/plain",
            "WWW-Authenticate":
              'Bearer resource_metadata="https://mcp.example.test/.well-known/oauth-protected-resource/mcp"',
          },
        });
      }
      if (url === "https://mcp.example.test/.well-known/oauth-protected-resource/mcp") {
        return Response.json({
          resource: "https://mcp.example.test/mcp",
          authorization_servers: ["https://auth.example.test"],
        });
      }
      if (url === "https://auth.example.test/.well-known/oauth-authorization-server") {
        return Response.json({
          issuer: "https://auth.example.test",
          authorization_endpoint: "https://auth.example.test/authorize",
          token_endpoint: "https://auth.example.test/token",
          ...(register ? { registration_endpoint: "https://auth.example.test/register" } : {}),
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
        });
      }
      if (register && url === "https://auth.example.test/register" && request.method === "POST") {
        return register();
      }
      throw new Error(`Unexpected request: ${request.method} ${url}`);
    }),
  );
  const tx = {
    $executeRaw: vi.fn().mockResolvedValue(1),
    $queryRaw: vi.fn().mockResolvedValue([]),
    mcpServer: {
      findFirst: vi.fn().mockResolvedValue({
        endpoint: "https://mcp.example.test/mcp",
        secretId: secret ? "secret-1" : null,
      }),
      update: vi.fn().mockResolvedValue({}),
    },
    secret: {
      findFirst: vi
        .fn()
        .mockResolvedValue(secret ? { id: "secret-1", ciphertext: "encrypted" } : undefined),
      create: vi.fn().mockResolvedValue({}),
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  };
  const prisma = {
    mcpServer: {
      findFirst: vi.fn().mockResolvedValue({
        id: "server-1",
        endpoint: "https://mcp.example.test/mcp",
        secretId: secret ? "secret-1" : null,
      }),
    },
    secret: {
      findFirst: vi
        .fn()
        .mockResolvedValue(secret ? { id: "secret-1", ciphertext: "encrypted" } : undefined),
      create: vi.fn(),
      deleteMany: vi.fn(),
    },
    mcpOAuthSession: oauthSessionStore(),
    $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
  };
  const broker = new McpOAuthBroker(
    prisma as never,
    {
      load: vi.fn(() => JSON.stringify(secret ? { secret } : {})),
      put: vi.fn(async () => ({ id: "secret-1", ciphertext: "encrypted" })),
    } as never,
    TEST_NETWORK,
  );
  const error = await broker
    .begin({
      serverId: "server-1",
      spaceId: "workspace-1",
      userId: "user-1",
      redirectUri: "http://127.0.0.1:5173/mcp/oauth/callback",
    })
    .then(
      () => null,
      (caught: unknown) => caught,
    );
  expect(error).toBeInstanceOf(Error);
  return error as Error;
}

describe("MCP OAuth", () => {
  function expiringMaterial(obtainedAt: number) {
    return {
      oauth: {
        tokens: {
          access_token: "old-access",
          refresh_token: "old-refresh",
          token_type: "Bearer",
          expires_in: 7200,
        },
        obtainedAt,
        clientInformation: { client_id: "client-1" },
        discoveryState: {
          authorizationServerUrl: "https://auth.example.test",
          authorizationServerMetadata: {
            issuer: "https://auth.example.test",
            authorization_endpoint: "https://auth.example.test/authorize",
            token_endpoint: "https://auth.example.test/token",
            response_types_supported: ["code"],
          },
          resourceMetadata: {
            resource: "https://mcp.example.test",
            authorization_servers: ["https://auth.example.test"],
          },
        },
      },
    };
  }

  /**
   * One MCP server row and its secret records, shared by every broker the way the
   * API and worker share a database. The credential advisory lock is a real mutex
   * held until the transaction that took it ends.
   */
  function sharedCredentials(
    material: OAuthMaterial,
    endpoint: string | null = "https://mcp.example.test/mcp",
  ) {
    const values = new Map<string, string>();
    let nextRecord = 0;
    const secrets = {
      put: vi.fn(async (plaintext: string) => {
        nextRecord += 1;
        values.set(`cipher-${nextRecord}`, plaintext);
        return { id: `secret-${nextRecord}`, ciphertext: `cipher-${nextRecord}` };
      }),
      load: vi.fn(async (ciphertext: string) => {
        const value = values.get(ciphertext);
        if (value === undefined) throw new Error("secret not found");
        return value;
      }),
      delete: vi.fn(async (ciphertext: string) => {
        values.delete(ciphertext);
      }),
    };
    const rows: Array<{ id: string; ciphertext: string }> = [];
    const server = {
      id: "server-1",
      endpoint,
      secretId: null as string | null,
    };
    let lock = Promise.resolve();
    const lockSettings: string[] = [];
    const tables = {
      mcpServer: {
        findFirst: async () => ({ ...server }),
        update: async ({ data }: { data: { secretId: string | null } }) => {
          server.secretId = data.secretId;
          return { ...server };
        },
      },
      secret: {
        findFirst: async ({ where }: { where: { id: string } }) => {
          const row = rows.find((candidate) => candidate.id === where.id);
          return row ? { ...row } : null;
        },
        create: async ({ data }: { data: { id: string; ciphertext: string } }) => {
          rows.push({ id: data.id, ciphertext: data.ciphertext });
          return data;
        },
        deleteMany: async ({ where }: { where: { id: string } }) => {
          const index = rows.findIndex((row) => row.id === where.id);
          if (index >= 0) rows.splice(index, 1);
          return { count: index >= 0 ? 1 : 0 };
        },
        count: async ({ where }: { where: { ciphertext: string } }) =>
          rows.filter((row) => row.ciphertext === where.ciphertext).length,
      },
      botSecret: { count: async () => 0 },
      integrationProviderConfig: { count: async () => 0 },
    };
    const prisma = {
      ...tables,
      $transaction: async <T>(callback: (tx: unknown) => Promise<T>) => {
        let release: (() => void) | undefined;
        const tx = {
          ...tables,
          $queryRaw: async () => [],
          $executeRaw: async (sql: TemplateStringsArray) => {
            lockSettings.push(sql.join("?"));
            if (!sql.join("").includes("pg_advisory_xact_lock") || release) return 1;
            const held = lock;
            lock = new Promise<void>((resolve) => {
              release = resolve;
            });
            await held;
            return 1;
          },
        };
        try {
          return await callback(tx);
        } finally {
          release?.();
        }
      },
    };
    const ready = (async () => {
      const record = await secrets.put(JSON.stringify(material));
      rows.push(record);
      server.secretId = record.id;
    })();
    const stored = async (): Promise<OAuthMaterial> => {
      const row = rows.find((candidate) => candidate.id === server.secretId);
      return row ? JSON.parse(await secrets.load(row.ciphertext)) : {};
    };
    const context = { spaceId: "workspace-1", userId: "user-1" };
    /** A process of its own: a broker with nothing in memory but the database. */
    const startProcess = async (network: typeof fetch, allowPrivateEndpoint = false) => {
      await ready;
      const broker = new McpOAuthBroker(
        prisma as never,
        secrets as never,
        { fetch: network, resolveHostname: TEST_NETWORK.resolveHostname },
        allowPrivateEndpoint,
      );
      const provider = await broker.providerFor(server, context);
      if (!(provider instanceof StoredMcpOAuthProvider)) throw new Error("expected a provider");
      return { broker, provider };
    };
    /** Another writer (the settings API) replacing the stored credential. */
    const replaceStored = async (next: OAuthMaterial) => {
      const record = await secrets.put(JSON.stringify(next));
      rows.push(record);
      server.secretId = record.id;
    };
    return { startProcess, stored, replaceStored, server, context, lockSettings, tables };
  }

  /** A public-client authorization server: each refresh token works once. */
  function rotatingAuthServer(first = "old-refresh") {
    let generation = 0;
    let live: string | undefined = first;
    const requests: URLSearchParams[] = [];
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = logicalHref(input, init);
      if (url !== "https://auth.example.test/token") throw new Error(`Unexpected ${url}`);
      const body = new URLSearchParams(await new Request(input, init).text());
      requests.push(body);
      if (body.get("refresh_token") !== live) {
        return Response.json({ error: "invalid_grant" }, { status: 400 });
      }
      generation += 1;
      live = `refresh-${generation}`;
      return Response.json({
        access_token: `access-${generation}`,
        refresh_token: live,
        token_type: "Bearer",
        expires_in: 7200,
      });
    });
    return {
      fetch,
      requests,
      revoke: () => {
        live = undefined;
      },
    };
  }

  const EXPIRED = () => Date.now() - 3 * 60 * 60 * 1000;

  it("renews an expired token once and stores the rotated grant", async () => {
    const server = rotatingAuthServer();
    const shared = sharedCredentials(expiringMaterial(EXPIRED()));
    const { provider, broker } = await shared.startProcess(server.fetch);

    const [first, second] = await Promise.all([provider.tokens(), provider.tokens()]);

    expect(first).toMatchObject({ access_token: "access-1", refresh_token: "refresh-1" });
    expect(second).toMatchObject({ access_token: "access-1" });
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]?.get("grant_type")).toBe("refresh_token");
    expect(server.requests[0]?.get("refresh_token")).toBe("old-refresh");
    expect(server.requests[0]?.get("client_id")).toBe("client-1");
    expect(server.requests[0]?.get("resource")).toBe("https://mcp.example.test/");
    expect((await shared.stored()).oauth?.tokens).toMatchObject({ refresh_token: "refresh-1" });
    expect(await broker.statusFor(shared.server, shared.context)).toBe("connected");
    // Waiting for another process's refresh must not eat the budget for this one's write.
    expect(shared.lockSettings[0]).toContain("lock_timeout");
  });

  it("keeps a private-network HTTP resource through the broker and refresh when the instance opts in", async () => {
    const resource = "http://192.0.2.10:8123/mcp";
    const material = expiringMaterial(EXPIRED());
    material.oauth.discoveryState.resourceMetadata.resource = resource;
    const server = rotatingAuthServer();
    const shared = sharedCredentials(material, resource);
    const { provider } = await shared.startProcess(server.fetch, true);

    expect(await provider.validateResourceURL(resource, resource)).toEqual(new URL(resource));
    await provider.tokens();
    expect(server.requests[0]?.get("resource")).toBe(resource);
  });

  it.each([
    ["one after the other", false],
    ["at the same time", true],
  ])(
    "lets a second process adopt the rotated grant when both refresh %s",
    async (_name, concurrent) => {
      const server = rotatingAuthServer();
      const shared = sharedCredentials(expiringMaterial(EXPIRED()));
      const api = await shared.startProcess(server.fetch);
      const worker = await shared.startProcess(server.fetch);

      const [fromApi, fromWorker] = concurrent
        ? await Promise.all([api.provider.tokens(), worker.provider.tokens()])
        : [await api.provider.tokens(), await worker.provider.tokens()];

      expect(fromApi).toMatchObject({ access_token: "access-1", refresh_token: "refresh-1" });
      expect(fromWorker).toEqual(fromApi);
      expect(server.requests.map((request) => request.get("refresh_token"))).toEqual([
        "old-refresh",
      ]);
      expect((await shared.stored()).oauth?.tokens).toMatchObject({ refresh_token: "refresh-1" });
      expect(await worker.broker.statusFor(shared.server, shared.context)).toBe("connected");
    },
  );

  /**
   * An MCP server that has already revoked `old-access` before its stored expiry.
   * `onRejected` runs before each 401 so a test can line the rejections up.
   */
  function earlyRevokingMcpServer(
    authFetch: typeof globalThis.fetch,
    onRejected: () => Promise<void> = async () => undefined,
  ) {
    const bearers: string[] = [];
    const network = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      if (logicalHref(input, init) !== "https://mcp.example.test/mcp")
        return authFetch(input, init);
      const request = new Request(input, init);
      if (request.method !== "POST") return new Response(null, { status: 405 });
      const bearer = request.headers.get("authorization") ?? "";
      bearers.push(bearer);
      if (bearer === "Bearer old-access") {
        await onRejected();
        return new Response(null, { status: 401 });
      }
      const body = (await request.json()) as { id?: number; method: string };
      if (body.method !== "initialize") return new Response(null, { status: 202 });
      return Response.json({
        jsonrpc: "2.0",
        id: body.id,
        result: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          serverInfo: { name: "fake", version: "1" },
        },
      });
    });
    const connect = (provider: StoredMcpOAuthProvider, session: McpSession) =>
      session.connectRemote({
        url: "https://mcp.example.test/mcp",
        authProvider: provider,
        network: { fetch: network, resolveHostname: TEST_NETWORK.resolveHostname },
      });
    return { network, bearers, connect };
  }

  const reauthorizableMaterial = () => ({
    oauth: {
      ...expiringMaterial(Date.now()).oauth,
      redirectUri: "https://app.example.test/mcp/oauth/callback",
    },
  });

  it("routes the SDK's refresh after a 401 before expiry through one locked refresh", async () => {
    const auth = rotatingAuthServer();
    const shared = sharedCredentials(reauthorizableMaterial());
    // Hold both 401s until each process has one.
    let rejected = 0;
    let releaseRejections: () => void = () => undefined;
    const bothRejected = new Promise<void>((resolve) => {
      releaseRejections = resolve;
    });
    const mcp = earlyRevokingMcpServer(auth.fetch, async () => {
      rejected += 1;
      if (rejected === 2) releaseRejections();
      await bothRejected;
    });
    const api = await shared.startProcess(mcp.network);
    const worker = await shared.startProcess(mcp.network);
    const sessions = [new McpSession(), new McpSession()];

    try {
      await Promise.all([
        mcp.connect(api.provider, sessions[0] as McpSession),
        mcp.connect(worker.provider, sessions[1] as McpSession),
      ]);
    } finally {
      await Promise.all(sessions.map((session) => session.close()));
    }

    expect(auth.requests.map((request) => request.get("refresh_token"))).toEqual(["old-refresh"]);
    expect(await api.provider.tokens()).toMatchObject({ access_token: "access-1" });
    expect(await worker.provider.tokens()).toMatchObject({ access_token: "access-1" });
    expect(mcp.bearers.filter((bearer) => bearer !== "Bearer old-access")).toEqual(
      Array(mcp.bearers.length - 2).fill("Bearer access-1"),
    );
    expect((await shared.stored()).oauth?.tokens).toMatchObject({ refresh_token: "refresh-1" });
  });

  it("keeps the grant when the refresh after a 401 fails temporarily", async () => {
    const shared = sharedCredentials(reauthorizableMaterial());
    const mcp = earlyRevokingMcpServer(async () => {
      throw new TypeError("network unavailable");
    });
    const { provider } = await shared.startProcess(mcp.network);
    const before = await shared.stored();
    const session = new McpSession();

    try {
      const error = await mcp.connect(provider, session).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(McpReauthorizationRequiredError);
    } finally {
      await session.close();
    }

    expect(await provider.tokens()).toMatchObject({ access_token: "old-access" });
    expect(await shared.stored()).toEqual(before);
  });

  it("refreshes with the stored token when the adopted grant has expired as well", async () => {
    const server = rotatingAuthServer();
    const shared = sharedCredentials(expiringMaterial(EXPIRED()));
    const api = await shared.startProcess(server.fetch);
    const worker = await shared.startProcess(server.fetch);
    await api.provider.tokens();
    vi.useFakeTimers({ now: Date.now() + 3 * 60 * 60 * 1000, toFake: ["Date"] });
    try {
      expect(await worker.provider.tokens()).toMatchObject({ refresh_token: "refresh-2" });
    } finally {
      vi.useRealTimers();
    }
    expect(server.requests.map((request) => request.get("refresh_token"))).toEqual([
      "old-refresh",
      "refresh-1",
    ]);
  });

  it("never overwrites a rotated grant with a stale process's clear or metadata write", async () => {
    const server = rotatingAuthServer();
    const shared = sharedCredentials(expiringMaterial(EXPIRED()));
    const api = await shared.startProcess(server.fetch);
    const worker = await shared.startProcess(server.fetch);
    await api.provider.tokens();

    // The SDK clears tokens after a rejected refresh of the stale copy.
    await worker.provider.invalidateCredentials("tokens");
    expect((await shared.stored()).oauth?.tokens).toMatchObject({ refresh_token: "refresh-1" });
    expect(await worker.provider.tokens()).toMatchObject({ refresh_token: "refresh-1" });

    await worker.provider.saveDiscoveryState({
      authorizationServerUrl: "https://auth.example.test",
    });
    expect((await shared.stored()).oauth).toMatchObject({
      tokens: { refresh_token: "refresh-1" },
      discoveryState: { authorizationServerUrl: "https://auth.example.test" },
    });
    expect(await worker.broker.statusFor(shared.server, shared.context)).toBe("connected");
  });

  it("lets newly issued tokens replace the stored grant", async () => {
    const server = rotatingAuthServer();
    const shared = sharedCredentials(expiringMaterial(EXPIRED()));
    const api = await shared.startProcess(server.fetch);
    const worker = await shared.startProcess(server.fetch);
    await api.provider.tokens();

    await worker.provider.saveTokens({
      access_token: "reauthorized",
      refresh_token: "reauthorized-refresh",
      token_type: "Bearer",
    });

    expect((await shared.stored()).oauth?.tokens).toMatchObject({
      refresh_token: "reauthorized-refresh",
    });

    // A reused access token still carries a newly issued refresh token.
    await worker.provider.saveTokens({
      access_token: "reauthorized",
      refresh_token: "reissued-refresh",
      token_type: "Bearer",
    });
    expect((await shared.stored()).oauth?.tokens).toMatchObject({
      refresh_token: "reissued-refresh",
    });
  });

  it("clears only the tokens when the stored grant is revoked", async () => {
    const server = rotatingAuthServer();
    server.revoke();
    const shared = sharedCredentials(expiringMaterial(EXPIRED()));
    const { provider, broker } = await shared.startProcess(server.fetch);

    const [first, second] = await Promise.all([provider.tokens(), provider.tokens()]);

    expect(first).toBeUndefined();
    expect(second).toBeUndefined();
    expect(await provider.tokens()).toBeUndefined();
    expect(server.requests).toHaveLength(1);
    const stored = await shared.stored();
    expect(stored.oauth?.tokens).toBeUndefined();
    expect(stored.oauth?.obtainedAt).toBeUndefined();
    expect(stored.oauth?.clientInformation).toEqual({ client_id: "client-1" });
    expect(provider.clientInformation()).toEqual({ client_id: "client-1" });
    expect(await broker.statusFor(shared.server, shared.context)).toBe("reconnect");
  });

  it.each([
    [
      "the network fails",
      async () => {
        throw new TypeError("network unavailable");
      },
    ],
    ["the server errors", async () => Response.json({ error: "server_error" }, { status: 500 })],
  ])("keeps the current token when %s", async (_name, fetch) => {
    const shared = sharedCredentials(expiringMaterial(EXPIRED()));
    const { provider } = await shared.startProcess(vi.fn(fetch));
    const before = await shared.stored();

    expect(await provider.tokens()).toMatchObject({ access_token: "old-access" });
    expect(await shared.stored()).toEqual(before);
  });

  it("stores a rotated grant when the first commit after the refresh fails", async () => {
    const server = rotatingAuthServer();
    const shared = sharedCredentials(expiringMaterial(EXPIRED()));
    const { provider } = await shared.startProcess(server.fetch);
    const update = shared.tables.mcpServer.update;
    let failures = 1;
    shared.tables.mcpServer.update = async (args) => {
      if (failures-- > 0) throw new Error("connection terminated unexpectedly");
      return update(args);
    };

    expect(await provider.tokens()).toMatchObject({ access_token: "access-1" });
    expect(server.requests.map((request) => request.get("refresh_token"))).toEqual(["old-refresh"]);
    expect((await shared.stored()).oauth?.tokens).toMatchObject({ refresh_token: "refresh-1" });
  });

  it("keeps a rotated grant for this run when every commit fails", async () => {
    const server = rotatingAuthServer();
    const shared = sharedCredentials(expiringMaterial(EXPIRED()));
    const { provider } = await shared.startProcess(server.fetch);
    shared.tables.mcpServer.update = async () => {
      throw new Error("connection terminated unexpectedly");
    };

    expect(await provider.tokens()).toMatchObject({ access_token: "access-1" });
    expect(server.requests.map((request) => request.get("refresh_token"))).toEqual(["old-refresh"]);
  });

  it("lets a disconnect that lands during a failed refresh commit win", async () => {
    const server = rotatingAuthServer();
    const shared = sharedCredentials(expiringMaterial(EXPIRED()));
    const { provider, broker } = await shared.startProcess(server.fetch);
    const update = shared.tables.mcpServer.update;
    let failures = 1;
    shared.tables.mcpServer.update = async (args) => {
      if (failures-- > 0) {
        await shared.replaceStored({ headers: { "X-Team": "blue" } });
        throw new Error("connection terminated unexpectedly");
      }
      return update(args);
    };

    expect(await provider.tokens()).toBeUndefined();

    expect(await shared.stored()).toEqual({ headers: { "X-Team": "blue" } });
    expect(await broker.statusFor(shared.server, shared.context)).toBe("none");
  });

  it.each(["disconnect", "client changed", "server mismatch", "server gone", "endpoint changed"])(
    "refuses a rotated grant after a failed commit when %s",
    async (change) => {
      const server = rotatingAuthServer();
      const material = {
        ...expiringMaterial(EXPIRED()),
        oauthClient: { client_id: "client-1" },
      };
      const shared = sharedCredentials(material);
      const { provider } = await shared.startProcess(server.fetch);
      const replacement: OAuthMaterial =
        change === "client changed"
          ? { oauthClient: { client_id: "replacement-client" } }
          : change === "server mismatch"
            ? {
                oauthClient: {
                  client_id: "client-1",
                  authorization_server: "https://other.example.test/",
                },
              }
            : { headers: { "X-Team": "blue" } };
      shared.tables.mcpServer.update = async () => {
        await shared.replaceStored(replacement);
        if (change === "server gone") shared.tables.mcpServer.findFirst = async () => null as never;
        if (change === "endpoint changed")
          shared.server.endpoint = "https://other.example.test/mcp";
        throw new Error("connection terminated unexpectedly");
      };

      expect(await provider.tokens()).toBeUndefined();
      expect(server.requests.map((request) => request.get("refresh_token"))).toEqual([
        "old-refresh",
      ]);
      expect(await shared.stored()).toEqual(replacement);
    },
  );

  it.each([false, true])(
    "keeps an observed disconnect when the fallback commit also fails (pre-registered: %s)",
    async (preRegistered) => {
      const server = rotatingAuthServer();
      const shared = sharedCredentials({
        ...expiringMaterial(EXPIRED()),
        ...(preRegistered ? { oauthClient: { client_id: "client-1" } } : {}),
      });
      const { provider } = await shared.startProcess(server.fetch);
      let first = true;
      const replacement = { headers: { "X-Team": "blue" } };
      shared.tables.mcpServer.update = async () => {
        if (first) {
          first = false;
          await shared.replaceStored(replacement);
        }
        throw new Error("connection terminated unexpectedly");
      };

      expect(await provider.tokens()).toBeUndefined();
      expect(server.requests.map((request) => request.get("refresh_token"))).toEqual([
        "old-refresh",
      ]);
      expect(await shared.stored()).toEqual(replacement);
    },
  );

  it.each([false, true])(
    "keeps the available grant when both commits fail transiently (newer stored grant: %s)",
    async (newerStoredGrant) => {
      const server = rotatingAuthServer();
      const shared = sharedCredentials(expiringMaterial(EXPIRED()));
      const { provider } = await shared.startProcess(server.fetch);
      const replacement = expiringMaterial(Date.now());
      replacement.oauth.tokens.access_token = "newer-access";
      replacement.oauth.tokens.refresh_token = "newer-refresh";
      let commits = 0;
      shared.tables.mcpServer.update = async () => {
        if (commits++ === 0 && newerStoredGrant) await shared.replaceStored(replacement);
        throw new Error("connection terminated unexpectedly");
      };

      expect(await provider.tokens()).toMatchObject({
        access_token: newerStoredGrant ? "newer-access" : "access-1",
      });
      expect(commits).toBe(2);
      expect(server.requests.map((request) => request.get("refresh_token"))).toEqual([
        "old-refresh",
      ]);
      expect(await shared.stored()).toEqual(
        newerStoredGrant
          ? replacement
          : expect.objectContaining({
              oauth: expect.objectContaining({
                tokens: expect.objectContaining({ refresh_token: "old-refresh" }),
              }),
            }),
      );
    },
  );

  it("keeps a rotated grant over the clear a queued process stores after a failed commit", async () => {
    const server = rotatingAuthServer();
    const shared = sharedCredentials(expiringMaterial(EXPIRED()));
    const api = await shared.startProcess(server.fetch);
    const worker = await shared.startProcess(server.fetch);
    const update = shared.tables.mcpServer.update;
    let queued: Promise<unknown> | undefined;
    shared.tables.mcpServer.update = async (args) => {
      if (!queued) {
        queued = worker.provider.tokens();
        await vi.waitFor(() =>
          expect(shared.lockSettings.filter((sql) => sql.includes("advisory"))).toHaveLength(2),
        );
        throw new Error("connection terminated unexpectedly");
      }
      return update(args);
    };

    expect(await api.provider.tokens()).toMatchObject({ access_token: "access-1" });
    await queued;
    expect(server.requests.map((request) => request.get("refresh_token"))).toEqual([
      "old-refresh",
      "old-refresh",
    ]);
    expect((await shared.stored()).oauth?.tokens).toMatchObject({ refresh_token: "refresh-1" });
    expect(await api.broker.statusFor(shared.server, shared.context)).toBe("connected");
  });

  it("does not renew a token that is still inside its lifetime", async () => {
    const server = rotatingAuthServer();
    const shared = sharedCredentials(expiringMaterial(Date.now() - 10 * 60 * 1000));
    const { provider } = await shared.startProcess(server.fetch);

    expect(await provider.tokens()).toMatchObject({ access_token: "old-access" });
    expect(server.fetch).not.toHaveBeenCalled();
  });

  it("rejects unsafe browser authorization URLs", async () => {
    const onAuthorization = vi.fn();
    const provider = new StoredMcpOAuthProvider(
      "server-1",
      { oauth: { tokens: { access_token: "working", token_type: "bearer" } } },
      async () => undefined,
      { onAuthorization },
    );

    await expect(
      provider.redirectToAuthorization(new URL("http://auth.example.test/authorize")),
    ).rejects.toThrow(/HTTPS/i);

    expect(provider.authorizationUrl).toBeUndefined();
    expect(onAuthorization).not.toHaveBeenCalled();
    expect(await provider.tokens()).toMatchObject({ access_token: "working" });
  });

  it("allows private-network HTTP authorization URLs only when the instance opts in", async () => {
    const url = new URL("http://192.0.2.10:8123/auth/authorize");
    const allowed = new StoredMcpOAuthProvider("server-1", {}, async () => undefined, {
      onAuthorization: vi.fn(),
      allowPrivateEndpoint: true,
    });
    await allowed.redirectToAuthorization(url);
    expect(allowed.authorizationUrl).toEqual(url);

    const denied = new StoredMcpOAuthProvider("server-1", {}, async () => undefined, {
      onAuthorization: vi.fn(),
    });
    await expect(denied.redirectToAuthorization(url)).rejects.toThrow(/HTTPS/i);
  });

  it("binds a private-network HTTP resource only when the instance opts in", async () => {
    const resource = "http://192.0.2.10:8123/mcp";
    const allowed = new StoredMcpOAuthProvider("server-1", {}, async () => undefined, {
      allowPrivateEndpoint: true,
    });
    const denied = new StoredMcpOAuthProvider("server-1", {}, async () => undefined);

    expect(await allowed.validateResourceURL("http://192.0.2.10:8123/mcp", resource)).toEqual(
      new URL(resource),
    );
    expect(
      await denied.validateResourceURL("http://192.0.2.10:8123/mcp", resource),
    ).toBeUndefined();
  });

  it("allows localhost HTTP browser authorization URLs", async () => {
    const onAuthorization = vi.fn();
    const provider = new StoredMcpOAuthProvider("server-1", {}, async () => undefined, {
      onAuthorization,
    });
    const authorizationUrl = new URL("http://127.0.0.1:5173/authorize");

    await provider.redirectToAuthorization(authorizationUrl);

    expect(provider.authorizationUrl).toEqual(authorizationUrl);
    expect(onAuthorization).toHaveBeenCalledWith(authorizationUrl);
  });

  it("clears stale tokens when runtime authorization URL validation fails", async () => {
    const persisted: { oauth?: { tokens?: unknown } }[] = [];
    const provider = new StoredMcpOAuthProvider(
      "server-1",
      { oauth: { tokens: { access_token: "revoked", token_type: "bearer" } } },
      async (material) => {
        persisted.push(structuredClone(material));
      },
    );

    await expect(
      provider.redirectToAuthorization(new URL("http://auth.example.test/authorize")),
    ).rejects.toThrow(/HTTPS/i);

    expect(await provider.tokens()).toBeUndefined();
    expect(persisted.at(-1)?.oauth?.tokens).toBeUndefined();
  });

  it("persists SDK credentials and invalidates only the requested scope", async () => {
    const persisted: unknown[] = [];
    const provider = new StoredMcpOAuthProvider(
      "server-1",
      {
        oauth: {
          redirectUri: "http://127.0.0.1:5173/mcp/oauth/callback",
          tokens: { access_token: "old", refresh_token: "refresh", token_type: "bearer" },
          clientInformation: { client_id: "client-1" },
          discoveryState: { authorizationServerUrl: "https://auth.example.test" },
        },
      },
      async (material) => {
        persisted.push(structuredClone(material));
      },
    );

    await provider.saveTokens({
      access_token: "new",
      refresh_token: "rotated",
      token_type: "bearer",
    });
    await provider.invalidateCredentials("tokens");

    expect(await provider.tokens()).toBeUndefined();
    expect(provider.clientInformation()).toEqual({ client_id: "client-1" });
    expect(provider.discoveryState()).toMatchObject({
      authorizationServerUrl: "https://auth.example.test",
    });
    expect(persisted).toHaveLength(2);
    await expect(
      provider.redirectToAuthorization(new URL("https://auth.example.test/authorize")),
    ).rejects.toThrow(McpReauthorizationRequiredError);
  });

  it("clears stale tokens when runtime re-authorization is required so status flips to reconnect", async () => {
    const persisted: { oauth?: { tokens?: unknown } }[] = [];
    const provider = new StoredMcpOAuthProvider(
      "server-1",
      {
        oauth: {
          redirectUri: "http://127.0.0.1:5173/mcp/oauth/callback",
          tokens: { access_token: "revoked-server-side", token_type: "bearer" },
          clientInformation: { client_id: "client-1" },
        },
      },
      async (material) => {
        persisted.push(structuredClone(material));
      },
    );

    await expect(
      provider.redirectToAuthorization(new URL("https://auth.example.test/authorize")),
    ).rejects.toThrow(McpReauthorizationRequiredError);

    expect(await provider.tokens()).toBeUndefined();
    expect(persisted.at(-1)?.oauth?.tokens).toBeUndefined();
  });

  it.each(["https://mcp.example.test", "http://127.0.0.1:8080"])(
    "drives discovery, registration, PKCE, redirect, and token exchange for %s",
    async (mcpOrigin) => {
      const requests: string[] = [];
      let registration: Record<string, unknown> | undefined;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
          const request = input instanceof Request ? input : new Request(input, init);
          const url = new URL(logicalHref(input, init));
          requests.push(`${request.method} ${url.toString()}`);

          if (url.href === `${mcpOrigin}/mcp` && request.method === "POST") {
            return new Response(null, {
              status: 401,
              headers: {
                "WWW-Authenticate": `Bearer resource_metadata="${mcpOrigin}/.well-known/oauth-protected-resource/mcp"`,
              },
            });
          }
          if (url.href === `${mcpOrigin}/.well-known/oauth-protected-resource/mcp`) {
            return Response.json({
              resource: `${mcpOrigin}/mcp`,
              authorization_servers: ["https://auth.example.test"],
            });
          }
          if (url.href === "https://auth.example.test/.well-known/oauth-authorization-server") {
            return Response.json({
              issuer: "https://auth.example.test",
              authorization_endpoint: "https://auth.example.test/authorize",
              token_endpoint: "https://auth.example.test/token",
              registration_endpoint: "https://auth.example.test/register",
              response_types_supported: ["code"],
              grant_types_supported: ["authorization_code", "refresh_token"],
              code_challenge_methods_supported: ["S256"],
            });
          }
          if (url.href === "https://auth.example.test/register" && request.method === "POST") {
            registration = (await request.json()) as Record<string, unknown>;
            return Response.json(
              {
                client_id: "registered-client-id",
                redirect_uris: ["http://127.0.0.1:5173/mcp/oauth/callback"],
                token_endpoint_auth_method: "none",
              },
              { status: 201 },
            );
          }
          if (url.href === "https://auth.example.test/token" && request.method === "POST") {
            return Response.json({
              access_token: "access-token",
              refresh_token: "refresh-token",
              token_type: "bearer",
              expires_in: 3600,
            });
          }
          throw new Error(`Unexpected request: ${request.method} ${url}`);
        }),
      );
      let secretCounter = 0;
      const storedPayloads: string[] = [];
      const put = vi.fn(async (plaintext: string) => {
        storedPayloads.push(plaintext);
        secretCounter += 1;
        return { id: `secret-${secretCounter}`, ciphertext: `encrypted-${secretCounter}` };
      });
      const tx = {
        $executeRaw: vi.fn().mockResolvedValue(1),
        $queryRaw: vi.fn().mockResolvedValue([]),
        mcpServer: {
          findFirst: vi.fn().mockResolvedValue({
            endpoint: `${mcpOrigin}/mcp`,
            secretId: null,
          }),
          update: vi.fn().mockResolvedValue({}),
        },
        secret: {
          findFirst: vi.fn(),
          create: vi.fn().mockResolvedValue({}),
          deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
      };
      const prisma = {
        mcpServer: {
          findFirst: vi.fn().mockResolvedValue({
            id: "server-1",
            endpoint: `${mcpOrigin}/mcp`,
            secretId: null,
          }),
          update: vi.fn().mockResolvedValue({}),
        },
        secret: {
          findFirst: vi.fn(),
          create: vi.fn().mockResolvedValue({}),
          deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
        mcpOAuthSession: oauthSessionStore(),
        deploymentSettings: deploymentOwner("user-1"),
        $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
      };
      const broker = new McpOAuthBroker(prisma as never, { put } as never, TEST_NETWORK, true);

      const started = await broker.begin({
        serverId: "server-1",
        spaceId: "workspace-1",
        userId: "user-1",
        redirectUri: "http://127.0.0.1:5173/mcp/oauth/callback",
      });
      expect(started.status).toBe("authorization_required");
      if (started.status !== "authorization_required") throw new Error("OAuth was not requested");
      const authorizationUrl = new URL(started.authorizationUrl);

      expect(registration).toMatchObject({ client_name: "Rakazo", application_type: "native" });
      expect(authorizationUrl.origin).toBe("https://auth.example.test");
      expect(authorizationUrl.searchParams.get("client_id")).toBe("registered-client-id");
      expect(authorizationUrl.searchParams.get("code_challenge_method")).toBe("S256");
      expect(authorizationUrl.searchParams.get("state")).toBe(started.sessionId);

      const second = await broker.begin({
        serverId: "server-1",
        spaceId: "workspace-1",
        userId: "user-1",
        redirectUri: "http://127.0.0.1:5173/mcp/oauth/callback",
      });
      expect(second.status).toBe("authorization_required");
      if (second.status !== "authorization_required") throw new Error("OAuth was not requested");
      expect(second.sessionId).not.toBe(started.sessionId);

      await broker.complete({
        sessionId: started.sessionId,
        code: "authorization-code",
        state: started.sessionId,
        spaceId: "workspace-1",
        userId: "user-1",
      });

      expect(requests).toContain("POST https://auth.example.test/token");
      expect(
        storedPayloads
          .map((value) => JSON.parse(value))
          .some((value) => value.oauth?.tokens?.access_token === "access-token"),
      ).toBe(true);
      expect(prisma.mcpServer.update).toHaveBeenCalledWith({
        where: { id: "server-1" },
        data: { revision: { increment: 1 } },
      });
    },
  );

  it("applies the transport URL policy to OAuth traffic: no plain-HTTP endpoints, no redirects", async () => {
    const fetchCalls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init);
        const url = logicalHref(input, init);
        fetchCalls.push(`${request.method} ${url}`);
        if (url === "http://insecure.example.test/mcp") {
          return new Response(null, {
            status: 401,
            headers: {
              "WWW-Authenticate":
                'Bearer resource_metadata="http://insecure.example.test/.well-known/oauth-protected-resource/mcp"',
            },
          });
        }
        throw new Error(`Unexpected request: ${request.method} ${url}`);
      }),
    );
    const prisma = {
      mcpServer: {
        findFirst: vi.fn().mockResolvedValue({
          id: "server-1",
          endpoint: "http://insecure.example.test/mcp",
          secretId: null,
        }),
        update: vi.fn().mockResolvedValue({}),
      },
      secret: { findFirst: vi.fn(), create: vi.fn(), deleteMany: vi.fn() },
      mcpOAuthSession: oauthSessionStore(),
      $transaction: vi.fn().mockResolvedValue([]),
    };
    const broker = new McpOAuthBroker(prisma as never, { put: vi.fn() } as never, TEST_NETWORK);

    await expect(
      broker.begin({
        serverId: "server-1",
        spaceId: "workspace-1",
        userId: "user-1",
        redirectUri: "http://127.0.0.1:5173/mcp/oauth/callback",
      }),
    ).rejects.toThrow(/HTTPS/i);
    expect(fetchCalls).toEqual([]);
  });

  it.each([
    ["http://localhost:3100/api/auth/get-session", /HTTPS/],
    ["http://127.0.0.1:3100/mcp", /HTTPS/],
    ["https://localhost:3100/mcp", /private/],
  ])("refuses loopback %s for a user who is not the deployment owner", async (endpoint, reason) => {
    const fetch = vi.fn(async () => new Response("internal handler body", { status: 405 }));
    const prisma = {
      mcpServer: {
        findFirst: vi.fn().mockResolvedValue({ id: "server-1", endpoint, secretId: null }),
      },
      secret: { findFirst: vi.fn() },
      mcpOAuthSession: oauthSessionStore(),
      deploymentSettings: deploymentOwner("owner"),
    };
    const broker = new McpOAuthBroker(prisma as never, { put: vi.fn() } as never, {
      fetch,
      resolveHostname: async () => [{ address: "127.0.0.1", family: 4 }],
    });

    await expect(
      broker.begin({
        serverId: "server-1",
        spaceId: "workspace-1",
        userId: "user-1",
        redirectUri: "http://127.0.0.1:5173/mcp/oauth/callback",
      }),
    ).rejects.toThrow(reason);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not reflect upstream response text when starting OAuth fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("UPSTREAM_BODY_MARKER internal detail", { status: 500 })),
    );
    const prisma = {
      mcpServer: {
        findFirst: vi.fn().mockResolvedValue({
          id: "server-1",
          endpoint: "https://mcp.example.test/mcp",
          secretId: null,
        }),
      },
      secret: { findFirst: vi.fn() },
      mcpOAuthSession: oauthSessionStore(),
    };
    const broker = new McpOAuthBroker(prisma as never, { put: vi.fn() } as never, TEST_NETWORK);

    const error = await broker
      .begin({
        serverId: "server-1",
        spaceId: "workspace-1",
        userId: "user-1",
        redirectUri: "http://127.0.0.1:5173/mcp/oauth/callback",
      })
      .then(
        () => null,
        (caught: unknown) => caught,
      );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("Could not start MCP OAuth");
    expect((error as Error).message).not.toContain("UPSTREAM_BODY_MARKER");
  });

  it("reports the HTTP status and OAuth error when registration is rejected", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init);
        const url = logicalHref(input, init);
        if (url === "https://mcp.example.test/mcp" && request.method === "POST") {
          return new Response("missing bearer token", {
            status: 401,
            headers: {
              "content-type": "text/plain",
              "WWW-Authenticate":
                'Bearer resource_metadata="https://mcp.example.test/.well-known/oauth-protected-resource/mcp"',
            },
          });
        }
        if (url === "https://mcp.example.test/.well-known/oauth-protected-resource/mcp") {
          return Response.json({
            resource: "https://mcp.example.test/mcp",
            authorization_servers: ["https://auth.example.test"],
          });
        }
        if (url === "https://auth.example.test/.well-known/oauth-authorization-server") {
          return Response.json({
            issuer: "https://auth.example.test",
            authorization_endpoint: "https://auth.example.test/authorize",
            token_endpoint: "https://auth.example.test/token",
            registration_endpoint: "https://auth.example.test/register",
            response_types_supported: ["code"],
            grant_types_supported: ["authorization_code", "refresh_token"],
            code_challenge_methods_supported: ["S256"],
          });
        }
        if (url === "https://auth.example.test/register" && request.method === "POST") {
          return Response.json(
            {
              error: "registration_not_supported",
              error_description:
                "Dynamic client registration is not supported. Only pre-registered partners are allowed.",
            },
            { status: 403 },
          );
        }
        throw new Error(`Unexpected request: ${request.method} ${url}`);
      }),
    );
    const tx = {
      $executeRaw: vi.fn().mockResolvedValue(1),
      $queryRaw: vi.fn().mockResolvedValue([]),
      mcpServer: {
        findFirst: vi.fn().mockResolvedValue({
          endpoint: "https://mcp.example.test/mcp",
          secretId: null,
        }),
        update: vi.fn().mockResolvedValue({}),
      },
      secret: {
        findFirst: vi.fn(),
        create: vi.fn().mockResolvedValue({}),
        deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const prisma = {
      mcpServer: {
        findFirst: vi.fn().mockResolvedValue({
          id: "server-1",
          endpoint: "https://mcp.example.test/mcp",
          secretId: null,
        }),
      },
      secret: { findFirst: vi.fn(), create: vi.fn(), deleteMany: vi.fn() },
      mcpOAuthSession: oauthSessionStore(),
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    };
    const broker = new McpOAuthBroker(
      prisma as never,
      { put: vi.fn(async () => ({ id: "secret-1", ciphertext: "encrypted" })) } as never,
      TEST_NETWORK,
    );

    const error = await broker
      .begin({
        serverId: "server-1",
        spaceId: "workspace-1",
        userId: "user-1",
        redirectUri: "http://127.0.0.1:5173/mcp/oauth/callback",
      })
      .then(
        () => null,
        (caught: unknown) => caught,
      );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      "Could not start MCP OAuth: HTTP 403 registration_not_supported: Dynamic client registration is not supported. Only pre-registered partners are allowed.",
    );
    expect((error as Error).message).not.toContain("[object Response]");
  });

  it("reports the OAuth status and code when the description is redacted", async () => {
    const error = await rejectedOAuthBegin(
      () =>
        Response.json(
          {
            error: "registration_not_supported",
            error_description:
              "Use Bearer access-token-value or quote static-credential-value to continue.",
          },
          { status: 403 },
        ),
      "static-credential-value",
    );

    expect(error.message).toBe(
      "Could not start MCP OAuth: HTTP 403 registration_not_supported: Use Bearer [redacted] or quote [redacted] to continue.",
    );
    expect(error.message).not.toContain("access-token-value");
    expect(error.message).not.toContain("static-credential-value");
  });

  it("reports the OAuth status and code when the description exceeds the sanitized message", async () => {
    const description = `${"a".repeat(2_500)} tail-marker`;
    const error = await rejectedOAuthBegin(() =>
      Response.json(
        { error: "registration_not_supported", error_description: description },
        { status: 403 },
      ),
    );

    expect(error.message).toBe(
      `Could not start MCP OAuth: HTTP 403 registration_not_supported: ${"a".repeat(300)}`,
    );
    expect(error.message).not.toContain("tail-marker");
  });

  it("redacts a secret that crosses the caller-facing description cut", async () => {
    const secret = "cross-boundary-secret-value";
    const error = await rejectedOAuthBegin(
      () =>
        Response.json(
          {
            error: "registration_not_supported",
            error_description: `${"a".repeat(290)}${secret}`,
          },
          { status: 403 },
        ),
      secret,
    );

    expect(error.message).toBe(
      `Could not start MCP OAuth: HTTP 403 registration_not_supported: ${"a".repeat(290)}[redacted]`,
    );
    expect(error.message).not.toContain(secret.slice(0, 10));
  });

  it("stops reading an oversized OAuth error body", async () => {
    const totalBytes = 128 * 1_024;
    const chunkBytes = 1_024;
    const tracked = trackedClone(
      new Response(chunkedBody(totalBytes, chunkBytes), {
        status: 403,
        headers: { "content-type": "application/json" },
      }),
    );

    const error = await rejectedOAuthBegin(() => tracked.response);

    expect(tracked.bytesRead()).toBeGreaterThan(0);
    expect(tracked.bytesRead()).toBeLessThanOrEqual(8_000 * 3 + chunkBytes);
    expect(tracked.bytesRead()).toBeLessThan(totalBytes);
    expect(error.message).toBe("Could not start MCP OAuth");
    expect(error.message).not.toContain("a".repeat(300));
  });

  it("does not read an OAuth error body whose declared length exceeds the cap", async () => {
    const tracked = trackedClone(
      new Response(chunkedBody(64 * 1_024, 1_024), {
        status: 403,
        headers: {
          "content-type": "application/json",
          "content-length": String(1024 * 1024),
        },
      }),
    );

    const error = await rejectedOAuthBegin(() => tracked.response);

    expect(tracked.bytesRead()).toBe(0);
    expect(error.message).toBe("Could not start MCP OAuth");
  });

  it("asks for a pre-registered client when the server cannot register one", async () => {
    const error = await rejectedOAuthBegin(null);

    expect(error).toBeInstanceOf(McpOAuthClientRequiredError);
    expect(error).toMatchObject({ code: MCP_OAUTH_CLIENT_REQUIRED });
  });

  describe("with a pre-registered client", () => {
    const oauthClient = { client_id: "registered-client", client_secret: "registered-secret" };
    const AUTH_SERVER = "https://auth.example.test/";

    function authorizationUrlOf(started: { status: string; authorizationUrl?: string }): URL {
      return new URL(started.authorizationUrl ?? "");
    }

    /** An authorization server that only accepts clients registered out of band. */
    function nonRegisteringAuthServer(
      onToken: (request: Request) => Promise<Response | undefined> | Response | undefined,
      {
        challenge = true,
        metadataReads = Number.POSITIVE_INFINITY,
        resourceScopes,
        serverScopes,
      }: {
        challenge?: boolean;
        metadataReads?: number;
        /** `scopes_supported` the resource publishes (RFC 9728). */
        resourceScopes?: string[];
        /** `scopes_supported` the authorization server publishes (RFC 8414). */
        serverScopes?: string[];
      } = {},
    ) {
      let metadataServed = 0;
      const requested: string[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
          const request = input instanceof Request ? input : new Request(input, init);
          const url = logicalHref(input, init);
          requested.push(`${request.method} ${url}`);
          if (url === "https://mcp.example.test/mcp" && request.method === "POST" && !challenge) {
            // Like Google's MCP servers: the handshake is open, only tool calls need a token.
            const body = (await request.json()) as { id?: number; method: string };
            if (body.method !== "initialize") return new Response(null, { status: 202 });
            return Response.json({
              jsonrpc: "2.0",
              id: body.id,
              result: {
                protocolVersion: "2025-06-18",
                capabilities: { tools: {} },
                serverInfo: { name: "open-handshake", version: "1" },
              },
            });
          }
          if (url === "https://mcp.example.test/mcp" && request.method === "POST") {
            return new Response(null, {
              status: 401,
              headers: {
                "WWW-Authenticate":
                  'Bearer resource_metadata="https://mcp.example.test/.well-known/oauth-protected-resource/mcp"',
              },
            });
          }
          if (url === "https://mcp.example.test/.well-known/oauth-protected-resource/mcp") {
            metadataServed += 1;
            if (metadataServed > metadataReads) return new Response("unavailable", { status: 503 });
            return Response.json({
              resource: "https://mcp.example.test/mcp",
              authorization_servers: ["https://auth.example.test"],
              ...(resourceScopes ? { scopes_supported: resourceScopes } : {}),
            });
          }
          if (url === "https://auth.example.test/.well-known/oauth-authorization-server") {
            return Response.json({
              issuer: "https://auth.example.test",
              authorization_endpoint: "https://auth.example.test/authorize",
              token_endpoint: "https://auth.example.test/token",
              response_types_supported: ["code"],
              code_challenge_methods_supported: ["S256"],
              ...(serverScopes ? { scopes_supported: serverScopes } : {}),
            });
          }
          if (url === "https://auth.example.test/token" && request.method === "POST") {
            const rejected = await onToken(request);
            if (rejected) return rejected;
            return Response.json({
              access_token: "issued-access",
              refresh_token: "issued-refresh",
              token_type: "Bearer",
              expires_in: 3600,
            });
          }
          throw new Error(`Unexpected request: ${request.method} ${url}`);
        }),
      );
      return requested;
    }

    function brokerWithMaterial(
      material: OAuthMaterial,
      server: { transport?: string; endpoint?: string | null } = {},
    ) {
      const tables = {
        mcpServer: {
          findFirst: vi.fn().mockResolvedValue({
            id: "server-1",
            endpoint: "https://mcp.example.test/mcp",
            secretId: "secret-1",
            ...server,
          }),
          update: vi.fn().mockResolvedValue({}),
        },
        secret: {
          findFirst: vi.fn().mockResolvedValue({ id: "secret-1", ciphertext: "encrypted" }),
          create: vi.fn().mockResolvedValue({}),
          deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
      };
      const tx = {
        ...tables,
        $executeRaw: vi.fn().mockResolvedValue(1),
        $queryRaw: vi.fn().mockResolvedValue([]),
      };
      const prisma = {
        ...tables,
        mcpOAuthSession: oauthSessionStore(),
        $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
      };
      const secrets = {
        load: vi.fn(async () => JSON.stringify(material)),
        put: vi.fn(async () => ({ id: "session-secret", ciphertext: "session-encrypted" })),
      };
      return {
        broker: new McpOAuthBroker(prisma as never, secrets as never, TEST_NETWORK),
        prisma,
        secrets,
      };
    }

    it("authorizes with the configured client instead of registering one", async () => {
      const requested = nonRegisteringAuthServer(() => undefined);
      const { broker, secrets } = brokerWithMaterial({ oauthClient });

      const started = await broker.begin({
        serverId: "server-1",
        spaceId: "workspace-1",
        userId: "user-1",
        redirectUri: "https://app.example.test/mcp/oauth/callback",
      });

      expect(started.status).toBe("authorization_required");
      const authorizationUrl = new URL(
        started.status === "authorization_required" ? started.authorizationUrl : "",
      );
      expect(authorizationUrl.origin + authorizationUrl.pathname).toBe(
        "https://auth.example.test/authorize",
      );
      expect(authorizationUrl.searchParams.get("client_id")).toBe("registered-client");
      expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(
        "https://app.example.test/mcp/oauth/callback",
      );
      expect(requested.some((request) => request.includes("/register"))).toBe(false);
      // The pending session keeps the client so a restarted API can finish the exchange.
      const sessionWrite = (secrets.put.mock.calls as unknown[][]).find(
        (call) => (call[1] as { operationId?: string }).operationId === "mcp.oauth.session",
      );
      const session = JSON.parse(sessionWrite?.[0] as string) as OAuthMaterial;
      expect(session.oauthClient).toMatchObject(oauthClient);
    });

    it("exchanges the code with the configured client's secret", async () => {
      let authorization: string | null = null;
      let body = new URLSearchParams();
      nonRegisteringAuthServer(async (request) => {
        authorization = request.headers.get("authorization");
        body = new URLSearchParams(await request.text());
      });
      const sessionId = "0b6f3a51-3c7e-4bb4-9a59-2d2f1c1f6a10";
      const { broker, prisma } = brokerWithMaterial({
        oauthClient,
        oauth: {
          redirectUri: "https://app.example.test/mcp/oauth/callback",
          codeVerifier: "verifier",
          discoveryState: {
            authorizationServerUrl: "https://auth.example.test",
            authorizationServerMetadata: {
              issuer: "https://auth.example.test",
              authorization_endpoint: "https://auth.example.test/authorize",
              token_endpoint: "https://auth.example.test/token",
              response_types_supported: ["code"],
            },
          },
        },
      });
      prisma.mcpOAuthSession.findFirst.mockResolvedValue({
        id: sessionId,
        serverId: "server-1",
        endpoint: "https://mcp.example.test/mcp",
        redirectUri: "https://app.example.test/mcp/oauth/callback",
        oauthCiphertext: "session-encrypted",
        createdAt: new Date(),
      });

      await broker
        .complete({
          sessionId,
          code: "authorization-code",
          state: sessionId,
          spaceId: "workspace-1",
          userId: "user-1",
        })
        .catch(() => undefined);

      expect(authorization).toBe(
        `Basic ${Buffer.from("registered-client:registered-secret").toString("base64")}`,
      );
      expect(body.get("code")).toBe("authorization-code");
      expect(body.get("code_verifier")).toBe("verifier");
    });

    it("keeps the client secret out of a failed code exchange", async () => {
      nonRegisteringAuthServer(() =>
        Response.json(
          {
            error: "server_error",
            error_description: "client secret registered-secret rejected",
          },
          { status: 400 },
        ),
      );
      const sessionId = "4a1c8e2f-6b3d-4f0a-9c7e-1d2b3a4c5e6f";
      const { broker, prisma } = brokerWithMaterial({
        oauthClient,
        oauth: {
          redirectUri: "https://app.example.test/mcp/oauth/callback",
          codeVerifier: "verifier",
          discoveryState: {
            authorizationServerUrl: "https://auth.example.test",
            authorizationServerMetadata: {
              issuer: "https://auth.example.test",
              authorization_endpoint: "https://auth.example.test/authorize",
              token_endpoint: "https://auth.example.test/token",
              response_types_supported: ["code"],
            },
          },
        },
      });
      prisma.mcpOAuthSession.findFirst.mockResolvedValue({
        id: sessionId,
        serverId: "server-1",
        endpoint: "https://mcp.example.test/mcp",
        redirectUri: "https://app.example.test/mcp/oauth/callback",
        oauthCiphertext: "session-encrypted",
        createdAt: new Date(),
      });
      const warn = vi.spyOn(getLogger(), "warn");

      const error = await broker
        .complete({
          sessionId,
          code: "authorization-code",
          state: sessionId,
          spaceId: "workspace-1",
          userId: "user-1",
        })
        .then(
          () => undefined,
          (caught: unknown) => caught as Error,
        );

      expect(error?.message).toContain("Could not complete MCP OAuth");
      expect(error?.message).not.toContain("registered-secret");
      expect(warn).toHaveBeenCalled();
      for (const call of warn.mock.calls) expect(String(call)).not.toContain("registered-secret");
      warn.mockRestore();
    });

    it("refreshes an expired grant with the configured client", async () => {
      const server = rotatingAuthServer();
      const { clientInformation: _registered, ...oauth } = expiringMaterial(EXPIRED()).oauth;
      const shared = sharedCredentials({ oauthClient, oauth });
      const { provider } = await shared.startProcess(server.fetch);

      await expect(provider.tokens()).resolves.toMatchObject({ access_token: "access-1" });

      expect(server.requests).toHaveLength(1);
      // The rotated grant is stored next to the client, which stays configured.
      expect(await shared.stored()).toMatchObject({
        oauthClient,
        oauth: { tokens: { refresh_token: "refresh-1" } },
      });
    });

    it("keeps the configured client when OAuth is disconnected", async () => {
      const shared = sharedCredentials({ oauthClient, oauth: expiringMaterial(Date.now()).oauth });
      const { broker } = await shared.startProcess(rotatingAuthServer().fetch);

      await broker.disconnect({ serverId: "server-1", ...shared.context });

      expect(await shared.stored()).toEqual({ oauthClient });
      expect(await broker.statusFor(shared.server, shared.context)).toBe("none");
    });

    it("keeps credential files when OAuth is disconnected", async () => {
      const files = { GOOGLE_OAUTH_CREDENTIALS: '{"token":"{{oauth.access_token}}"}' };
      const shared = sharedCredentials({ files, oauth: expiringMaterial(Date.now()).oauth });
      const { broker } = await shared.startProcess(rotatingAuthServer().fetch);

      await broker.disconnect({ serverId: "server-1", ...shared.context });

      expect(await shared.stored()).toEqual({ files });
    });

    it("refuses tokens from an authorization started before the client was changed", async () => {
      const shared = sharedCredentials({ oauthClient, oauth: { redirectUri: "https://app/cb" } });
      const { provider } = await shared.startProcess(rotatingAuthServer().fetch);
      const replacement = { oauthClient: { client_id: "replacement-client" } };
      await shared.replaceStored(replacement);

      await expect(
        provider.saveTokens({ access_token: "for-old-client", token_type: "Bearer" }),
      ).rejects.toThrow("OAuth client changed");

      expect(await shared.stored()).toEqual(replacement);
    });

    it("binds the client to the authorization server it is first used with", async () => {
      nonRegisteringAuthServer(() => undefined);
      const { broker, secrets } = brokerWithMaterial({ oauthClient });

      await broker.begin({
        serverId: "server-1",
        spaceId: "workspace-1",
        userId: "user-1",
        redirectUri: "https://app.example.test/mcp/oauth/callback",
      });

      const persisted = (secrets.put.mock.calls as unknown[][])
        .filter((call) => (call[1] as { operationId?: string }).operationId === "mcp.oauth.persist")
        .map((call) => JSON.parse(call[0] as string) as OAuthMaterial);
      expect(persisted.at(-1)?.oauthClient).toEqual({
        ...oauthClient,
        authorization_server: "https://auth.example.test/",
      });
    });

    it("never sends the client to a different authorization server", async () => {
      const requested = nonRegisteringAuthServer(() => undefined);
      const { broker, secrets } = brokerWithMaterial({
        oauthClient: { ...oauthClient, authorization_server: "https://trusted-auth.example.test/" },
      });

      await expect(
        broker.begin({
          serverId: "server-1",
          spaceId: "workspace-1",
          userId: "user-1",
          redirectUri: "https://app.example.test/mcp/oauth/callback",
        }),
      ).rejects.toThrow("authorization server");

      expect(requested.some((request) => request.includes("/token"))).toBe(false);
      expect(
        (secrets.put.mock.calls as unknown[][]).some(
          (call) => (call[1] as { operationId?: string }).operationId === "mcp.oauth.session",
        ),
      ).toBe(false);
    });

    it("refuses tokens from an overlapping flow that discovered a different server", async () => {
      // Two flows load the same unbound client; the other one is saved first and binds it.
      const discovery = {
        authorizationServerUrl: "https://auth.example.test",
        authorizationServerMetadata: {
          issuer: "https://auth.example.test",
          authorization_endpoint: "https://auth.example.test/authorize",
          token_endpoint: "https://auth.example.test/token",
          response_types_supported: ["code"],
        },
      };
      const shared = sharedCredentials({
        oauthClient,
        oauth: { redirectUri: "https://app/cb", discoveryState: discovery },
      });
      const { provider } = await shared.startProcess(rotatingAuthServer().fetch);
      const boundElsewhere = {
        oauthClient: { ...oauthClient, authorization_server: "https://trusted-auth.example.test/" },
        oauth: { redirectUri: "https://app/cb" },
      };
      await shared.replaceStored(boundElsewhere);

      await expect(
        provider.saveTokens({ access_token: "from-other-server", token_type: "Bearer" }),
      ).rejects.toThrow("authorization server");

      expect(await shared.stored()).toEqual(boundElsewhere);
    });

    it("checks the code exchange against the binding stored after the flow began", async () => {
      const requested = nonRegisteringAuthServer(() => undefined);
      const sessionId = "6c1d7f0e-2a4b-4c8d-9e3f-5a6b7c8d9e0f";
      const { broker, prisma, secrets } = brokerWithMaterial({});
      // The flow began with the client unbound and discovered auth.example.test; an
      // overlapping flow has since bound the stored client to another server.
      const flow: OAuthMaterial = {
        oauthClient,
        oauth: {
          redirectUri: "https://app.example.test/mcp/oauth/callback",
          codeVerifier: "verifier",
          discoveryState: {
            authorizationServerUrl: "https://auth.example.test",
            authorizationServerMetadata: {
              issuer: "https://auth.example.test",
              authorization_endpoint: "https://auth.example.test/authorize",
              token_endpoint: "https://auth.example.test/token",
              response_types_supported: ["code"],
            },
          },
        },
      };
      const stored: OAuthMaterial = {
        oauthClient: { ...oauthClient, authorization_server: "https://trusted-auth.example.test/" },
      };
      (secrets.load as ReturnType<typeof vi.fn>).mockImplementation(async (ciphertext: string) =>
        JSON.stringify(ciphertext === "session-encrypted" ? flow : stored),
      );
      prisma.mcpOAuthSession.findFirst.mockResolvedValue({
        id: sessionId,
        serverId: "server-1",
        endpoint: "https://mcp.example.test/mcp",
        redirectUri: "https://app.example.test/mcp/oauth/callback",
        oauthCiphertext: "session-encrypted",
        createdAt: new Date(),
      });

      await expect(
        broker.complete({
          sessionId,
          code: "authorization-code",
          state: sessionId,
          spaceId: "workspace-1",
          userId: "user-1",
        }),
      ).rejects.toThrow("authorization server");

      expect(requested.some((request) => request.includes("/token"))).toBe(false);
    });

    it("does not refresh against an authorization server the client is not bound to", async () => {
      const server = rotatingAuthServer();
      const { clientInformation: _registered, ...oauth } = expiringMaterial(EXPIRED()).oauth;
      const shared = sharedCredentials({
        oauthClient: { ...oauthClient, authorization_server: "https://trusted-auth.example.test/" },
        oauth,
      });
      const { provider } = await shared.startProcess(server.fetch);

      await provider.tokens();

      expect(server.requests).toHaveLength(0);
    });

    it("starts authorization when the server publishes OAuth metadata but does not challenge", async () => {
      const requested = nonRegisteringAuthServer(() => undefined, { challenge: false });
      const { broker } = brokerWithMaterial({ oauthClient });

      const started = await broker.begin({
        serverId: "server-1",
        spaceId: "workspace-1",
        userId: "user-1",
        redirectUri: "https://app.example.test/mcp/oauth/callback",
      });

      expect(started.status).toBe("authorization_required");
      const authorizationUrl = new URL(
        started.status === "authorization_required" ? started.authorizationUrl : "",
      );
      expect(authorizationUrl.origin).toBe("https://auth.example.test");
      expect(authorizationUrl.searchParams.get("client_id")).toBe("registered-client");
      expect(requested.some((request) => request.includes("/register"))).toBe(false);
    });

    it("keeps authorization on the advertised server when a later metadata read fails", async () => {
      const requested = nonRegisteringAuthServer(() => undefined, {
        challenge: false,
        metadataReads: 1,
      });
      const { broker } = brokerWithMaterial({ oauthClient });

      const started = await broker.begin({
        serverId: "server-1",
        spaceId: "workspace-1",
        userId: "user-1",
        redirectUri: "https://app.example.test/mcp/oauth/callback",
      });

      expect(started.status).toBe("authorization_required");
      expect(
        new URL(started.status === "authorization_required" ? started.authorizationUrl : "").origin,
      ).toBe("https://auth.example.test");
      expect(
        requested.some((request) =>
          request.includes("mcp.example.test/.well-known/oauth-authorization-server"),
        ),
      ).toBe(false);
    });

    it("keeps the configured scope out of the client information handed to the SDK", () => {
      const provider = new StoredMcpOAuthProvider(
        "server-1",
        {
          oauthClient: { ...oauthClient, scope: "read write", authorization_server: AUTH_SERVER },
          oauth: { discoveryState: { authorizationServerUrl: "https://auth.example.test" } },
        },
        async () => undefined,
      );

      expect(provider.clientInformation()).toEqual(oauthClient);
    });

    it("authorizes with the configured scope when the server publishes OAuth metadata but does not challenge", async () => {
      nonRegisteringAuthServer(() => undefined, { challenge: false });
      const { broker } = brokerWithMaterial({
        oauthClient: { ...oauthClient, scope: "mail.read mail.send" },
      });

      const started = await broker.begin({
        serverId: "server-1",
        spaceId: "workspace-1",
        userId: "user-1",
        redirectUri: "https://app.example.test/mcp/oauth/callback",
      });

      expect(authorizationUrlOf(started).searchParams.get("scope")).toBe("mail.read mail.send");
    });

    it("authorizes with the configured scope when the server challenges", async () => {
      nonRegisteringAuthServer(() => undefined);
      const { broker } = brokerWithMaterial({
        oauthClient: { ...oauthClient, scope: "mail.read mail.send" },
      });

      const started = await broker.begin({
        serverId: "server-1",
        spaceId: "workspace-1",
        userId: "user-1",
        redirectUri: "https://app.example.test/mcp/oauth/callback",
      });

      expect(authorizationUrlOf(started).searchParams.get("scope")).toBe("mail.read mail.send");
    });

    describe("offline_access", () => {
      const begin = {
        serverId: "server-1",
        spaceId: "workspace-1",
        userId: "user-1",
        redirectUri: "https://app.example.test/mcp/oauth/callback",
      };

      it("asks for it with the published scopes when the authorization server offers it", async () => {
        nonRegisteringAuthServer(() => undefined, {
          resourceScopes: ["mail.read"],
          serverScopes: ["mail.read", "offline_access"],
        });
        const { broker } = brokerWithMaterial({ oauthClient });

        const started = await broker.begin(begin);

        const url = authorizationUrlOf(started);
        expect(url.searchParams.get("scope")).toBe("mail.read offline_access");
        expect(url.searchParams.has("prompt")).toBe(false);
      });

      it("asks for it at the issuer of a stdio server", async () => {
        nonRegisteringAuthServer(() => undefined, {
          serverScopes: ["mail.read", "mail.send", "offline_access"],
        });
        const { broker } = brokerWithMaterial(
          {
            oauthClient: {
              ...oauthClient,
              authorization_server: AUTH_SERVER,
              scope: "mail.read mail.send",
            },
          },
          { transport: "stdio", endpoint: null },
        );

        const started = await broker.begin(begin);

        expect(authorizationUrlOf(started).searchParams.get("scope")).toBe(
          "mail.read mail.send offline_access",
        );
      });

      it("asks for it with the configured scope when the authorization server offers it", async () => {
        nonRegisteringAuthServer(() => undefined, {
          serverScopes: ["mail.read", "mail.send", "offline_access"],
        });
        const { broker } = brokerWithMaterial({
          oauthClient: { ...oauthClient, scope: "mail.read mail.send" },
        });

        const started = await broker.begin(begin);

        expect(authorizationUrlOf(started).searchParams.get("scope")).toBe(
          "mail.read mail.send offline_access",
        );
      });

      it("does not repeat it when the configured scope already asks for it", async () => {
        nonRegisteringAuthServer(() => undefined, {
          serverScopes: ["mail.read", "offline_access"],
        });
        const { broker } = brokerWithMaterial({
          oauthClient: { ...oauthClient, scope: "offline_access mail.read" },
        });

        const started = await broker.begin(begin);

        expect(authorizationUrlOf(started).searchParams.get("scope")).toBe(
          "offline_access mail.read",
        );
      });

      it("leaves the published scopes alone when the authorization server does not offer it", async () => {
        nonRegisteringAuthServer(() => undefined, {
          resourceScopes: ["mail.read"],
          serverScopes: ["mail.read"],
        });
        const { broker } = brokerWithMaterial({ oauthClient });

        const started = await broker.begin(begin);

        expect(authorizationUrlOf(started).searchParams.get("scope")).toBe("mail.read");
      });

      it("requests no scope when neither the resource nor the client names one", async () => {
        nonRegisteringAuthServer(() => undefined, {
          serverScopes: ["mail.read", "offline_access"],
        });
        const { broker } = brokerWithMaterial({ oauthClient });

        const started = await broker.begin(begin);

        expect(authorizationUrlOf(started).searchParams.has("scope")).toBe(false);
      });
    });

    describe("for a stdio server", () => {
      const stdio = { transport: "stdio", endpoint: null };
      const stdioClient = {
        ...oauthClient,
        authorization_server: AUTH_SERVER,
        scope: "mail.read mail.send",
      };
      const discoveryState = {
        authorizationServerUrl: "https://auth.example.test",
        authorizationServerMetadata: {
          issuer: "https://auth.example.test",
          authorization_endpoint: "https://auth.example.test/authorize",
          token_endpoint: "https://auth.example.test/token",
          response_types_supported: ["code"],
        },
      };
      const begin = {
        serverId: "server-1",
        spaceId: "workspace-1",
        userId: "user-1",
        redirectUri: "https://app.example.test/mcp/oauth/callback",
      };

      it("authorizes at the issuer without contacting an MCP endpoint", async () => {
        const requested = nonRegisteringAuthServer(() => undefined);
        const { broker, prisma } = brokerWithMaterial({ oauthClient: stdioClient }, stdio);

        const started = await broker.begin(begin);

        expect(started.status).toBe("authorization_required");
        const url = authorizationUrlOf(started);
        expect(url.origin + url.pathname).toBe("https://auth.example.test/authorize");
        expect(url.searchParams.get("client_id")).toBe("registered-client");
        expect(url.searchParams.get("scope")).toBe("mail.read mail.send");
        expect(url.searchParams.get("redirect_uri")).toBe(begin.redirectUri);
        expect(url.searchParams.get("code_challenge_method")).toBe("S256");
        expect(url.searchParams.get("code_challenge")).toBeTruthy();
        expect(url.searchParams.has("resource")).toBe(false);
        expect(requested.some((request) => request.includes("mcp.example.test"))).toBe(false);
        expect(requested.some((request) => request.includes("/register"))).toBe(false);
        // The session row's endpoint column holds the authorization server.
        expect(prisma.mcpOAuthSession.create).toHaveBeenCalledWith({
          data: expect.objectContaining({ serverId: "server-1", endpoint: AUTH_SERVER }),
        });
      });

      it("starts authorization for an expired grant without a refresh token", async () => {
        nonRegisteringAuthServer(() => undefined);
        const { broker } = brokerWithMaterial(
          {
            oauthClient: stdioClient,
            oauth: {
              discoveryState,
              obtainedAt: Date.now() - 7200_000,
              tokens: { access_token: "expired", token_type: "Bearer", expires_in: 3600 },
            },
          },
          stdio,
        );
        expect((await broker.begin(begin)).status).toBe("authorization_required");
      });

      const expiredRefreshable = {
        oauthClient: stdioClient,
        oauth: {
          discoveryState,
          obtainedAt: Date.now() - 7200_000,
          tokens: {
            access_token: "expired",
            refresh_token: "refresh-1",
            token_type: "Bearer",
            expires_in: 3600,
          },
        },
      };

      it("starts authorization for an expired grant whose refresh token was revoked", async () => {
        nonRegisteringAuthServer(() => Response.json({ error: "invalid_grant" }, { status: 400 }));
        const { broker } = brokerWithMaterial(structuredClone(expiredRefreshable), stdio);
        expect((await broker.begin(begin)).status).toBe("authorization_required");
      });

      it("never reports an expired grant whose refresh keeps failing as connected", async () => {
        nonRegisteringAuthServer(() => new Response("unavailable", { status: 503 }));
        const { broker } = brokerWithMaterial(structuredClone(expiredRefreshable), stdio);
        await expect(broker.begin(begin)).rejects.toThrow("Could not start MCP OAuth");
      });

      it("rejects a loopback issuer before sending credentials", async () => {
        const requested = nonRegisteringAuthServer(() => undefined);
        const { broker } = brokerWithMaterial(
          { oauthClient: { ...stdioClient, authorization_server: "https://127.0.0.1/" } },
          stdio,
        );
        await expect(broker.begin(begin)).rejects.toThrow(/private|loopback/i);
        expect(requested).toEqual([]);
      });

      it("still requires an authorization server", async () => {
        const requested = nonRegisteringAuthServer(() => undefined);
        const { broker } = brokerWithMaterial({ oauthClient }, stdio);

        await expect(broker.begin(begin)).rejects.toThrow("endpoint is required");

        expect(requested).toEqual([]);
      });

      it("does not start another authorization while the grant is usable", async () => {
        const requested = nonRegisteringAuthServer(() => undefined);
        const { broker } = brokerWithMaterial(
          {
            oauthClient: stdioClient,
            oauth: {
              discoveryState,
              obtainedAt: Date.now(),
              tokens: {
                access_token: "held",
                refresh_token: "held-refresh",
                token_type: "Bearer",
                expires_in: 3600,
              },
            },
          },
          stdio,
        );

        await expect(broker.begin(begin)).resolves.toEqual({ status: "already_connected" });

        expect(requested).toEqual([]);
      });

      it("applies the HTTPS policy to the authorization server", async () => {
        const requested = nonRegisteringAuthServer(() => undefined);
        const { broker } = brokerWithMaterial(
          { oauthClient: { ...stdioClient, authorization_server: "http://auth.example.test/" } },
          stdio,
        );

        await expect(broker.begin(begin)).rejects.toThrow("must use HTTPS");

        expect(requested).toEqual([]);
      });

      it("exchanges the code at the issuer with the configured client", async () => {
        let authorization: string | null = null;
        let body = new URLSearchParams();
        const requested = nonRegisteringAuthServer(async (request) => {
          authorization = request.headers.get("authorization");
          body = new URLSearchParams(await request.text());
        });
        const sessionId = "7d2e9c64-1a58-4b0e-8f3c-5e6a7b8c9d01";
        const { broker, prisma, secrets } = brokerWithMaterial(
          {
            oauthClient: stdioClient,
            oauth: {
              redirectUri: begin.redirectUri,
              codeVerifier: "verifier",
              discoveryState,
            },
          },
          stdio,
        );
        prisma.mcpOAuthSession.findFirst.mockResolvedValue({
          id: sessionId,
          serverId: "server-1",
          endpoint: AUTH_SERVER,
          redirectUri: begin.redirectUri,
          oauthCiphertext: "session-encrypted",
          createdAt: new Date(),
        });

        await broker.complete({
          sessionId,
          code: "authorization-code",
          state: sessionId,
          spaceId: "workspace-1",
          userId: "user-1",
        });

        expect(authorization).toBe(
          `Basic ${Buffer.from("registered-client:registered-secret").toString("base64")}`,
        );
        expect(body.get("code")).toBe("authorization-code");
        expect(body.get("code_verifier")).toBe("verifier");
        expect(body.has("resource")).toBe(false);
        expect(requested.some((request) => request.includes("mcp.example.test"))).toBe(false);
        const persisted = (secrets.put.mock.calls as unknown[][])
          .filter(
            (call) => (call[1] as { operationId?: string }).operationId === "mcp.oauth.persist",
          )
          .map((call) => JSON.parse(call[0] as string) as OAuthMaterial);
        expect(persisted.at(-1)?.oauth?.tokens).toMatchObject({
          access_token: "issued-access",
          refresh_token: "issued-refresh",
        });
        expect(prisma.mcpServer.update).toHaveBeenCalledWith({
          where: { id: "server-1" },
          data: { revision: { increment: 1 } },
        });
      });

      it("keeps the client secret out of a failed code exchange", async () => {
        nonRegisteringAuthServer(() =>
          Response.json(
            {
              error: "server_error",
              error_description: "client secret registered-secret rejected",
            },
            { status: 400 },
          ),
        );
        const sessionId = "c3b2a190-8e7d-4c6b-9a5f-4e3d2c1b0a99";
        const { broker, prisma } = brokerWithMaterial(
          {
            oauthClient: stdioClient,
            oauth: { redirectUri: begin.redirectUri, codeVerifier: "verifier", discoveryState },
          },
          stdio,
        );
        prisma.mcpOAuthSession.findFirst.mockResolvedValue({
          id: sessionId,
          serverId: "server-1",
          endpoint: AUTH_SERVER,
          redirectUri: begin.redirectUri,
          oauthCiphertext: "session-encrypted",
          createdAt: new Date(),
        });

        const error = await broker
          .complete({
            sessionId,
            code: "authorization-code",
            state: sessionId,
            spaceId: "workspace-1",
            userId: "user-1",
          })
          .then(
            () => undefined,
            (caught: unknown) => caught as Error,
          );

        expect(error?.message).toContain("Could not complete MCP OAuth");
        expect(error?.message).not.toContain("registered-secret");
      });

      it("refreshes an expired grant at the issuer", async () => {
        const server = rotatingAuthServer();
        const { clientInformation: _registered, ...oauth } = expiringMaterial(EXPIRED()).oauth;
        const { resourceMetadata: _resource, ...discovery } = oauth.discoveryState;
        const shared = sharedCredentials(
          { oauthClient: stdioClient, oauth: { ...oauth, discoveryState: discovery } },
          null,
        );
        const { provider } = await shared.startProcess(server.fetch);

        await expect(provider.tokens()).resolves.toMatchObject({ access_token: "access-1" });

        expect(server.requests).toHaveLength(1);
        expect(await shared.stored()).toMatchObject({
          oauthClient: stdioClient,
          oauth: { tokens: { refresh_token: "refresh-1" } },
        });
      });
    });

    it.each([
      ["scope", { scope: "calendar.readonly" }, { scope: "gmail.readonly" }],
      [
        "authorization server",
        { authorization_server: "https://auth.example.test/" },
        { authorization_server: "https://other-auth.example.test/" },
      ],
    ])(
      "refuses tokens from an authorization started before the client's %s changed",
      async (_name, before, after) => {
        const shared = sharedCredentials({
          oauthClient: { ...oauthClient, ...before },
          oauth: { redirectUri: "https://app/cb" },
        });
        const { provider } = await shared.startProcess(rotatingAuthServer().fetch);
        const replacement = { oauthClient: { ...oauthClient, ...after } };
        await shared.replaceStored(replacement);

        await expect(
          provider.saveTokens({ access_token: "for-old-settings", token_type: "Bearer" }),
        ).rejects.toThrow("OAuth client changed");

        expect(await shared.stored()).toEqual(replacement);
      },
    );

    it("adds the client's extra authorization parameters to the authorization URL", async () => {
      nonRegisteringAuthServer(() => undefined, { challenge: false });
      const { broker } = brokerWithMaterial({
        oauthClient: { ...oauthClient, authorization_params: "access_type=offline&prompt=consent" },
      });

      const started = await broker.begin({
        serverId: "server-1",
        spaceId: "workspace-1",
        userId: "user-1",
        redirectUri: "https://app.example.test/mcp/oauth/callback",
      });

      const url = new URL(
        started.status === "authorization_required" ? started.authorizationUrl : "",
      );
      expect(url.searchParams.get("access_type")).toBe("offline");
      expect(url.searchParams.get("prompt")).toBe("consent");
      expect(url.searchParams.get("client_id")).toBe("registered-client");
    });

    it("treats the client secret as a credential that must never be shown", () => {
      expect(oauthMaterialSecrets({ oauthClient })).toContain("registered-secret");
      expect(oauthMaterialSecrets({ oauthClient })).not.toContain("registered-client");
    });
  });

  it("treats a static credential file as a secret but not one built from the grant", () => {
    const key = '{"type":"service_account","private_key":"static-key"}';
    const secrets = oauthMaterialSecrets({
      files: { KEY_FILE: key, TOKEN_FILE: '{"token":"{{oauth.access_token}}"}', FLAG: "true" },
    });

    expect(secrets).toEqual([key]);
  });

  it("does not start authorization for a server that neither challenges nor publishes OAuth metadata", async () => {
    const requested: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init);
        const url = logicalHref(input, init);
        requested.push(`${request.method} ${url}`);
        if (url === "https://mcp.example.test/mcp" && request.method === "POST") {
          const body = (await request.json()) as { id?: number; method: string };
          if (body.method !== "initialize") return new Response(null, { status: 202 });
          return Response.json({
            jsonrpc: "2.0",
            id: body.id,
            result: {
              protocolVersion: "2025-06-18",
              capabilities: {},
              serverInfo: { name: "open", version: "1" },
            },
          });
        }
        return new Response("not found", { status: 404 });
      }),
    );
    const prisma = {
      mcpServer: {
        findFirst: vi.fn().mockResolvedValue({
          id: "server-1",
          endpoint: "https://mcp.example.test/mcp",
          secretId: null,
        }),
      },
      mcpOAuthSession: oauthSessionStore(),
    };
    const broker = new McpOAuthBroker(prisma as never, {} as never, TEST_NETWORK);

    await expect(
      broker.begin({
        serverId: "server-1",
        spaceId: "workspace-1",
        userId: "user-1",
        redirectUri: "https://app.example.test/mcp/oauth/callback",
      }),
    ).resolves.toEqual({ status: "authorization_not_requested" });
    expect(requested.filter((request) => request.startsWith("POST"))).toEqual([
      "POST https://mcp.example.test/mcp",
      "POST https://mcp.example.test/mcp",
    ]);
  });

  it("completes a persisted OAuth session after the API process restarts", async () => {
    const sessionId = "5d259fd9-b9fa-478e-a268-cc778816a043";
    let tokenRequestBody = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init);
        const url = logicalHref(input, init);
        if (url !== "https://auth.example.test/token") {
          throw new Error(`Unexpected request: ${request.method} ${url}`);
        }
        tokenRequestBody = await request.text();
        return Response.json({ access_token: "fresh", token_type: "bearer" });
      }),
    );
    const material = {
      oauth: {
        redirectUri: "http://127.0.0.1:5173/mcp/oauth/callback",
        codeVerifier: "persisted-verifier",
        clientInformation: { client_id: "persisted-client" },
        discoveryState: {
          authorizationServerUrl: "https://auth.example.test",
          resourceMetadata: {
            resource: "https://mcp.example.test/mcp",
            authorization_servers: ["https://auth.example.test"],
          },
          authorizationServerMetadata: {
            issuer: "https://auth.example.test",
            authorization_endpoint: "https://auth.example.test/authorize",
            token_endpoint: "https://auth.example.test/token",
            response_types_supported: ["code"],
            grant_types_supported: ["authorization_code"],
          },
        },
      },
    };
    const sessions = oauthSessionStore();
    sessions.findFirst.mockResolvedValue({
      id: sessionId,
      serverId: "server-1",
      endpoint: "https://mcp.example.test/mcp",
      redirectUri: material.oauth.redirectUri,
      oauthCiphertext: "session-first",
      createdAt: new Date(),
    });
    const prisma = {
      mcpServer: {
        findFirst: vi.fn().mockResolvedValue({
          id: "server-1",
          endpoint: "https://mcp.example.test/mcp",
          secretId: "secret-1",
        }),
        update: vi.fn().mockResolvedValue({}),
      },
      secret: {
        findFirst: vi.fn().mockResolvedValue({ id: "secret-1", ciphertext: "encrypted" }),
        create: vi.fn().mockResolvedValue({}),
        deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      mcpOAuthSession: sessions,
      $transaction: vi.fn().mockResolvedValue([]),
    };
    const secrets = {
      load: vi.fn((ciphertext: string) =>
        JSON.stringify(
          ciphertext === "session-first"
            ? material
            : { oauth: { ...material.oauth, codeVerifier: "wrong-later-verifier" } },
        ),
      ),
      put: vi.fn(async () => ({ id: "secret-2", ciphertext: "encrypted-2" })),
    };
    const restartedBroker = new McpOAuthBroker(prisma as never, secrets as never, TEST_NETWORK);

    await restartedBroker.complete({
      sessionId,
      code: "authorization-code",
      state: sessionId,
      spaceId: "workspace-1",
      userId: "user-1",
    });

    expect(sessions.deleteMany).toHaveBeenCalledWith({
      where: { id: sessionId, spaceId: "workspace-1", userId: "user-1" },
    });
    expect(new URLSearchParams(tokenRequestBody).get("code_verifier")).toBe("persisted-verifier");
    expect(prisma.mcpServer.update).toHaveBeenCalledWith({
      where: { id: "server-1" },
      data: { revision: { increment: 1 } },
    });
  });

  it("rotates the current credential inside a serialized database transaction", async () => {
    const tx = {
      $executeRaw: vi.fn().mockResolvedValue(1),
      $queryRaw: vi.fn().mockResolvedValue([]),
      mcpServer: {
        findFirst: vi.fn().mockResolvedValue({
          endpoint: "https://mcp.example.test/mcp",
          secretId: "secret-current",
        }),
        update: vi.fn().mockResolvedValue({}),
      },
      secret: {
        findFirst: vi.fn().mockResolvedValue({
          id: "secret-current",
          ciphertext: "encrypted-current",
        }),
        create: vi.fn().mockResolvedValue({}),
        deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const prisma = {
      mcpServer: {
        findFirst: vi.fn().mockResolvedValue({
          id: "server-1",
          endpoint: "https://mcp.example.test/mcp",
          secretId: "secret-current",
        }),
      },
      secret: {
        findFirst: vi.fn().mockResolvedValue({
          id: "secret-current",
          ciphertext: "encrypted-current",
        }),
      },
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    };
    const secrets = {
      load: vi.fn(() =>
        JSON.stringify({
          secret: "static-token",
          oauth: { tokens: { access_token: "oauth-token", token_type: "bearer" } },
        }),
      ),
      put: vi.fn(async () => ({ id: "secret-next", ciphertext: "encrypted-next" })),
    };
    const broker = new McpOAuthBroker(prisma as never, secrets as never, TEST_NETWORK);

    await broker.disconnect({
      serverId: "server-1",
      spaceId: "workspace-1",
      userId: "user-1",
    });

    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
    expect(tx.mcpServer.update).toHaveBeenCalledWith({
      where: { id: "server-1" },
      data: { secretId: "secret-next", revision: { increment: 1 } },
    });
    expect(tx.secret.deleteMany).toHaveBeenCalledWith({ where: { id: "secret-current" } });
  });

  it("merges OAuth state into the latest static credential after acquiring the lock", async () => {
    const storedPayloads: string[] = [];
    const tx = {
      $executeRaw: vi.fn().mockResolvedValue(1),
      $queryRaw: vi.fn().mockResolvedValue([]),
      mcpServer: {
        findFirst: vi.fn().mockResolvedValue({
          endpoint: "https://mcp.example.test/mcp",
          secretId: "secret-current",
        }),
        update: vi.fn().mockResolvedValue({}),
      },
      secret: {
        findFirst: vi.fn().mockResolvedValue({
          id: "secret-current",
          ciphertext: "encrypted-current",
        }),
        create: vi.fn().mockResolvedValue({}),
        deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    };
    const secrets = {
      load: vi.fn(() =>
        JSON.stringify({
          secret: "fresh-static-token",
          headers: { Authorization: "fresh-static-header" },
          oauth: { tokens: { access_token: "previous-oauth", token_type: "bearer" } },
        }),
      ),
      put: vi.fn(async (plaintext: string) => {
        storedPayloads.push(plaintext);
        return { id: "secret-next", ciphertext: "encrypted-next" };
      }),
    };
    const broker = new McpOAuthBroker(prisma as never, secrets as never, TEST_NETWORK);
    const provider = await broker.providerFor(
      {
        id: "server-1",
        endpoint: "https://mcp.example.test/mcp",
        secretId: "secret-before-edit",
      },
      { spaceId: "workspace-1", userId: "user-1" },
      {
        material: {
          secret: "stale-static-token",
          oauth: { tokens: { access_token: "stale-oauth", token_type: "bearer" } },
        },
        secretId: "secret-before-edit",
      },
    );
    if (!provider) throw new Error("expected an OAuth provider");

    await provider.saveTokens({ access_token: "fresh-oauth", token_type: "bearer" });

    expect(JSON.parse(storedPayloads.at(-1)!)).toMatchObject({
      secret: "fresh-static-token",
      headers: { Authorization: "fresh-static-header" },
      oauth: { tokens: { access_token: "fresh-oauth", token_type: "bearer" } },
    });
    expect(JSON.parse(storedPayloads.at(-1)!)).not.toMatchObject({
      secret: "stale-static-token",
    });

    tx.mcpServer.findFirst.mockResolvedValue({
      endpoint: "https://replacement.example.test/mcp",
      secretId: "secret-next",
    });
    await expect(
      provider.saveTokens({ access_token: "must-not-cross-origins", token_type: "bearer" }),
    ).rejects.toThrow(/endpoint changed/i);
    expect(secrets.put).toHaveBeenCalledTimes(1);
  });

  it("rejects redirects during OAuth discovery instead of following them", async () => {
    const requestedUrls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init);
        const url = logicalHref(input, init);
        requestedUrls.push(url);
        if (url === "https://mcp.example.test/mcp") {
          return new Response(null, {
            status: 401,
            headers: {
              "WWW-Authenticate":
                'Bearer resource_metadata="https://mcp.example.test/.well-known/oauth-protected-resource/mcp"',
            },
          });
        }
        if (url.startsWith("https://mcp.example.test/.well-known/")) {
          return new Response(null, {
            status: 302,
            headers: {
              Location: "https://attacker.example.test/.well-known/oauth-protected-resource/mcp",
            },
          });
        }
        throw new Error(`Unexpected request: ${request.method} ${url}`);
      }),
    );
    const prisma = {
      mcpServer: {
        findFirst: vi.fn().mockResolvedValue({
          id: "server-1",
          endpoint: "https://mcp.example.test/mcp",
          secretId: null,
        }),
        update: vi.fn().mockResolvedValue({}),
      },
      secret: { findFirst: vi.fn(), create: vi.fn(), deleteMany: vi.fn() },
      mcpOAuthSession: oauthSessionStore(),
      $transaction: vi.fn().mockResolvedValue([]),
    };
    const broker = new McpOAuthBroker(prisma as never, { put: vi.fn() } as never, TEST_NETWORK);

    await expect(
      broker.begin({
        serverId: "server-1",
        spaceId: "workspace-1",
        userId: "user-1",
        redirectUri: "http://127.0.0.1:5173/mcp/oauth/callback",
      }),
    ).rejects.toThrow(/redirect/i);
    expect(requestedUrls.every((url) => !url.includes("attacker.example.test"))).toBe(true);
  });

  it("retries safe OAuth discovery reads without replaying DCR writes", async () => {
    const requests: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init);
        const url = new URL(logicalHref(input, init));
        requests.push(`${request.method} ${url.toString()}`);

        if (url.href === "https://mcp.example.test/mcp" && request.method === "POST") {
          return new Response(null, {
            status: 401,
            headers: {
              "WWW-Authenticate":
                'Bearer resource_metadata="https://private-auth.example.test/.well-known/oauth-protected-resource/mcp"',
            },
          });
        }
        if (url.origin === "https://private-auth.example.test") throw new TypeError("fetch failed");
        if (url.href === "https://mcp.example.test/.well-known/oauth-protected-resource/mcp") {
          // Like Brex: the advertised canonical resource is the private alias.
          return Response.json({
            resource: "https://private-auth.example.test",
            authorization_servers: ["https://private-auth.example.test"],
          });
        }
        if (url.href === "https://mcp.example.test/.well-known/oauth-authorization-server") {
          return Response.json({
            issuer: "https://private-auth.example.test",
            authorization_endpoint: "https://login.example.test/authorize",
            token_endpoint: "https://login.example.test/token",
            registration_endpoint: "https://private-auth.example.test/register",
            response_types_supported: ["code"],
            grant_types_supported: ["authorization_code", "refresh_token"],
            code_challenge_methods_supported: ["S256"],
          });
        }
        throw new Error(`Unexpected request: ${request.method} ${url}`);
      }),
    );
    let secretCounter = 0;
    const put = vi.fn(async () => {
      secretCounter += 1;
      return { id: `secret-${secretCounter}`, ciphertext: `encrypted-${secretCounter}` };
    });
    const prisma = {
      mcpServer: {
        findFirst: vi.fn().mockResolvedValue({
          id: "server-1",
          endpoint: "https://mcp.example.test/mcp",
          secretId: null,
        }),
        update: vi.fn().mockResolvedValue({}),
      },
      secret: {
        findFirst: vi.fn(),
        create: vi.fn().mockResolvedValue({}),
        deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      mcpOAuthSession: oauthSessionStore(),
      $transaction: vi.fn().mockResolvedValue([]),
    };
    const broker = new McpOAuthBroker(prisma as never, { put } as never, TEST_NETWORK, true);

    await expect(
      broker.begin({
        serverId: "server-1",
        spaceId: "workspace-1",
        userId: "user-1",
        redirectUri: "http://127.0.0.1:5173/mcp/oauth/callback",
      }),
    ).rejects.toThrow(/Could not reach private-auth\.example\.test|Unexpected request/);

    expect(requests).toContain(
      "GET https://mcp.example.test/.well-known/oauth-protected-resource/mcp",
    );
    expect(requests).not.toContain("POST https://mcp.example.test/register");
  });
});

describe("MCP setup with an existing access token", () => {
  it.each(["https://mcp.example.test/mcp", "http://127.0.0.1:8080/mcp"])(
    "verifies %s using the stored token without starting OAuth",
    async (endpoint) => {
      const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
        const request = new Request(input, init);
        expect(logicalHref(input, init)).toBe(endpoint);
        expect(request.headers.get("authorization")).toBe("Bearer fake-executor-token");
        if (request.method !== "POST") return new Response(null, { status: 405 });
        const body = (await request.json()) as { id?: number; method: string };
        if (body.method === "initialize")
          return Response.json({
            jsonrpc: "2.0",
            id: body.id,
            result: {
              protocolVersion: "2025-03-26",
              capabilities: {},
              serverInfo: { name: "test", version: "1" },
            },
          });
        return new Response(null, { status: 202 });
      });
      const prisma = {
        mcpServer: {
          findFirst: vi.fn(async () => ({ id: "server", endpoint, secretId: "secret" })),
        },
        secret: { findFirst: vi.fn(async () => ({ id: "secret", ciphertext: "encrypted" })) },
        mcpOAuthSession: oauthSessionStore(),
        deploymentSettings: deploymentOwner("user"),
      };
      const secrets = {
        load: vi.fn(() => JSON.stringify({ secret: "fake-executor-token" })),
        put: vi.fn(),
      };
      const broker = new McpOAuthBroker(
        prisma as never,
        secrets as never,
        {
          ...TEST_NETWORK,
          fetch,
        },
        true,
      );
      await expect(
        broker.begin({
          serverId: "server",
          userId: "user",
          spaceId: "space",
          redirectUri: "https://app.example.test/mcp/oauth/callback",
        }),
      ).resolves.toEqual({ status: "authorization_not_requested" });
      expect(fetch).toHaveBeenCalled();
      expect(secrets.put).not.toHaveBeenCalled();
    },
  );
});
