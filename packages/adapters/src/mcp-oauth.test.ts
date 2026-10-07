import { afterEach, describe, expect, it, vi } from "vitest";
import {
  McpOAuthBroker,
  McpReauthorizationRequiredError,
  StoredMcpOAuthProvider,
} from "./mcp-oauth.js";

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
  register: () => Response | Promise<Response>,
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
          registration_endpoint: "https://auth.example.test/register",
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
        });
      }
      if (url === "https://auth.example.test/register" && request.method === "POST") {
        return register();
      }
      throw new Error(`Unexpected request: ${request.method} ${url}`);
    }),
  );
  const tx = {
    $executeRaw: vi.fn().mockResolvedValue(1),
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
    const broker = new McpOAuthBroker(prisma as never, { put } as never, TEST_NETWORK);

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
      const broker = new McpOAuthBroker(prisma as never, secrets as never, {
        ...TEST_NETWORK,
        fetch,
      });
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
