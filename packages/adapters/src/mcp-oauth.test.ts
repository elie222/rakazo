import { afterEach, describe, expect, it, vi } from "vitest";
import {
  McpOAuthBroker,
  McpReauthorizationRequiredError,
  StoredMcpOAuthProvider,
} from "./mcp-oauth.js";

afterEach(() => vi.unstubAllGlobals());

const TEST_NETWORK = {
  resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }],
};

function oauthSessionStore() {
  return {
    count: vi.fn().mockResolvedValue(0),
    findFirst: vi.fn(),
    create: vi.fn().mockResolvedValue({}),
    deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
  };
}

describe("MCP OAuth", () => {
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
    expect(provider.tokens()).toMatchObject({ access_token: "working" });
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

    expect(provider.tokens()).toBeUndefined();
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

    expect(provider.tokens()).toBeUndefined();
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

    expect(provider.tokens()).toBeUndefined();
    expect(persisted.at(-1)?.oauth?.tokens).toBeUndefined();
  });

  it("lets the official Streamable HTTP transport drive discovery, registration, PKCE, redirect, and token exchange", async () => {
    const requests: string[] = [];
    let registration: Record<string, unknown> | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init);
        const url = new URL(request.url);
        requests.push(`${request.method} ${url.toString()}`);

        if (url.href === "https://mcp.example.test/mcp" && request.method === "POST") {
          return new Response(null, {
            status: 401,
            headers: {
              "WWW-Authenticate":
                'Bearer resource_metadata="https://mcp.example.test/.well-known/oauth-protected-resource/mcp"',
            },
          });
        }
        if (url.href === "https://mcp.example.test/.well-known/oauth-protected-resource/mcp") {
          return Response.json({
            resource: "https://mcp.example.test/mcp",
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
        update: vi.fn().mockResolvedValue({}),
      },
      secret: {
        findFirst: vi.fn(),
        create: vi.fn().mockResolvedValue({}),
        deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      mcpOAuthSession: oauthSessionStore(),
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    };
    const broker = new McpOAuthBroker(prisma as never, { put } as never, TEST_NETWORK);

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
  });

  it("applies the transport URL policy to OAuth traffic: no plain-HTTP endpoints, no redirects", async () => {
    const fetchCalls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init);
        fetchCalls.push(`${request.method} ${request.url}`);
        if (request.url === "http://insecure.example.test/mcp") {
          return new Response(null, {
            status: 401,
            headers: {
              "WWW-Authenticate":
                'Bearer resource_metadata="http://insecure.example.test/.well-known/oauth-protected-resource/mcp"',
            },
          });
        }
        throw new Error(`Unexpected request: ${request.method} ${request.url}`);
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

  it("completes a persisted OAuth session after the API process restarts", async () => {
    const sessionId = "5d259fd9-b9fa-478e-a268-cc778816a043";
    let tokenRequestBody = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init);
        if (request.url !== "https://auth.example.test/token") {
          throw new Error(`Unexpected request: ${request.method} ${request.url}`);
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
        requestedUrls.push(request.url);
        if (request.url === "https://mcp.example.test/mcp") {
          return new Response(null, {
            status: 401,
            headers: {
              "WWW-Authenticate":
                'Bearer resource_metadata="https://mcp.example.test/.well-known/oauth-protected-resource/mcp"',
            },
          });
        }
        if (request.url.startsWith("https://mcp.example.test/.well-known/")) {
          return new Response(null, {
            status: 302,
            headers: {
              Location: "https://attacker.example.test/.well-known/oauth-protected-resource/mcp",
            },
          });
        }
        throw new Error(`Unexpected request: ${request.method} ${request.url}`);
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
        const url = new URL(request.url);
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
    const broker = new McpOAuthBroker(prisma as never, { put } as never, TEST_NETWORK);

    await expect(
      broker.begin({
        serverId: "server-1",
        spaceId: "workspace-1",
        userId: "user-1",
        redirectUri: "http://127.0.0.1:5173/mcp/oauth/callback",
      }),
    ).rejects.toThrow(/fetch failed|Unexpected request/);

    expect(requests).toContain(
      "GET https://mcp.example.test/.well-known/oauth-protected-resource/mcp",
    );
    expect(requests).not.toContain("POST https://mcp.example.test/register");
  });
});
