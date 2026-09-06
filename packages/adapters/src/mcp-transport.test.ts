import { strict as assert } from "node:assert";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StoredMcpOAuthProvider } from "./mcp-oauth.js";
import {
  McpSession,
  secureFetch,
  validateUrl,
  withEndpointOriginFallback,
} from "./mcp-transport.js";

afterEach(() => vi.unstubAllGlobals());

const TEST_NETWORK = {
  resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }],
};

describe("MCP transport seam", () => {
  it("rejects unsafe URLs and oversized URLs before network access", () => {
    expect(() => validateUrl("http://remote.example/mcp")).toThrow("HTTPS");
    expect(() => validateUrl("https://user:pass@example.com/mcp")).toThrow("credentials");
    expect(() => validateUrl(`https://example.com/${"x".repeat(2_100)}`)).toThrow("exceeds");
    expect(() => validateUrl("http://127.0.0.1:1234/mcp")).toThrow("HTTPS");
    expect(validateUrl("http://127.0.0.1:1234/mcp", { allowHttpLocalhost: true }).hostname).toBe(
      "127.0.0.1",
    );
  });

  it("gates stdio by exact command allowlist", async () => {
    const session = new McpSession();
    await expect(
      session.connectStdio({
        command: process.execPath,
        allowedCommands: ["/definitely-not-node"],
      }),
    ).rejects.toThrow("allowlist");
    await session.close();
    assert.ok(true);
  });

  it("rejects remote endpoints that resolve to a private address", async () => {
    const fetchImpl = vi.fn();
    const session = new McpSession();
    await expect(
      session.connectRemote({
        url: "https://metadata.example.test/mcp",
        fallbackToSse: false,
        network: {
          fetch: fetchImpl,
          resolveHostname: async () => [{ address: "169.254.169.254", family: 4 }],
        },
      }),
    ).rejects.toThrow("private address");
    expect(fetchImpl).not.toHaveBeenCalled();
    await session.close();
  });

  it("requires a connected session for operations", async () => {
    const session = new McpSession();
    await expect(session.listTools()).rejects.toThrow("not connected");
    await expect(session.callTool("echo")).rejects.toThrow("not connected");
  });

  it("preserves SDK session and protocol headers after stateful initialization", async () => {
    const requests: Request[] = [];
    const session = new McpSession();
    try {
      await session.connectRemote({
        url: "https://mcp.example.test/mcp",
        network: {
          ...TEST_NETWORK,
          fetch: vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
            const request = new Request(input, init);
            requests.push(request);
            const message = request.method === "POST" ? await request.json() : undefined;
            if (message?.method === "initialize") {
              return Response.json(
                {
                  jsonrpc: "2.0",
                  id: message.id,
                  result: {
                    protocolVersion: "2025-11-25",
                    capabilities: { tools: {} },
                    serverInfo: { name: "fake-stateful-server", version: "1" },
                  },
                },
                { headers: { "Mcp-Session-Id": "fake-session" } },
              );
            }
            if (
              request.headers.get("mcp-session-id") !== "fake-session" ||
              request.headers.get("mcp-protocol-version") !== "2025-11-25"
            ) {
              return new Response(null, { status: 400 });
            }
            if (request.method === "GET") return new Response(null, { status: 405 });
            if (message?.method === "tools/list") {
              return Response.json({ jsonrpc: "2.0", id: message.id, result: { tools: [] } });
            }
            return new Response(null, { status: 202 });
          }),
        },
      });

      await expect(session.listTools()).resolves.toEqual({ tools: [] });
      expect(requests[0]?.headers.has("mcp-session-id")).toBe(false);
      expect(requests.length).toBeGreaterThanOrEqual(3);
      expect(
        requests
          .slice(1)
          .every((request) => request.headers.get("mcp-session-id") === "fake-session"),
      ).toBe(true);
    } finally {
      await session.close();
    }
  });

  it.each([
    ["https://mcp.example.test/mcp", "http://localhost:8123"],
    ["https://mcp.example.test/mcp", "http://127.0.0.1:8123"],
    ["https://mcp.example.test/mcp", "http://[::1]:8123"],
    ["https://localhost:8123/mcp", "http://localhost:8123"],
    ["http://localhost:8123/mcp", "http://localhost:8124"],
    ["http://localhost:8123/mcp", "http://127.0.0.1:8123"],
    ["http://[::1]:8123/mcp", "http://[::1]:8124"],
  ])("does not extend the local exception from %s to %s", async (resource, origin) => {
    const fetchImpl = vi.fn();
    const safeFetch = secureFetch(
      new URL(resource),
      { allowHttpLocalhost: true, allowLocalHttpCredentials: true },
      {},
      { fetch: fetchImpl, ...TEST_NETWORK },
    );
    try {
      await expect(safeFetch(`${origin}/.well-known/oauth-protected-resource`)).rejects.toThrow(
        "HTTPS",
      );
      await expect(
        safeFetch(`${origin}/token`, { method: "POST", body: "fake-token-body" }),
      ).rejects.toThrow("HTTPS");
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      await safeFetch.close();
    }
  });

  it.each(["localhost", "127.0.0.1", "[::1]"])(
    "allows explicitly configured HTTP %s discovery and token traffic on the same origin",
    async (host) => {
      const origin = `http://${host}:8123`;
      const fetchImpl = vi.fn(async () => Response.json({ ok: true }));
      const resolveHostname = vi.fn();
      const safeFetch = secureFetch(
        new URL(`${origin}/mcp`),
        { allowHttpLocalhost: true },
        {},
        { fetch: fetchImpl, resolveHostname },
      );
      try {
        await expect(
          safeFetch(`${origin}/.well-known/oauth-protected-resource`),
        ).resolves.toHaveProperty("ok", true);
        await expect(
          safeFetch(`${origin}/token`, { method: "POST", body: "fake-token-body" }),
        ).resolves.toHaveProperty("ok", true);
        expect(fetchImpl).toHaveBeenCalledTimes(2);
        expect(resolveHostname).not.toHaveBeenCalled();
      } finally {
        await safeFetch.close();
      }
    },
  );

  it.each(["https://localhost:8123", "https://127.0.0.1:8123", "https://private.example.test"])(
    "applies remote network policy to discovery and token traffic at %s",
    async (origin) => {
      const fetchImpl = vi.fn();
      const safeFetch = secureFetch(
        new URL("http://localhost:8123/mcp"),
        { allowHttpLocalhost: true },
        {},
        {
          fetch: fetchImpl,
          resolveHostname: async () => [{ address: "10.0.0.1", family: 4 }],
        },
      );
      try {
        await expect(safeFetch(`${origin}/.well-known/oauth-protected-resource`)).rejects.toThrow(
          "private",
        );
        await expect(
          safeFetch(`${origin}/token`, { method: "POST", body: "fake-token-body" }),
        ).rejects.toThrow("private");
        expect(fetchImpl).not.toHaveBeenCalled();
      } finally {
        await safeFetch.close();
      }
    },
  );

  it("keeps SDK protocol headers on the resource origin and strips them on other origins", async () => {
    const safeFetch = secureFetch(
      new URL("https://mcp.example.test/mcp"),
      {},
      {},
      {
        ...TEST_NETWORK,
        fetch: vi.fn(async (_input: string | URL | Request, init?: RequestInit) =>
          Response.json(Object.fromEntries(new Headers(init?.headers))),
        ),
      },
    );
    const headers = {
      "mcp-session-id": "fake-session",
      "mcp-protocol-version": "2025-11-25",
      "last-event-id": "fake-event",
    };
    try {
      await expect(
        (await safeFetch("https://mcp.example.test/mcp", { headers })).json(),
      ).resolves.toEqual(headers);
      await expect(
        (await safeFetch("https://auth.example.test/discovery", { headers })).json(),
      ).resolves.toEqual({});
      await expect(
        (await safeFetch("https://mcp.example.test:8443/discovery", { headers })).json(),
      ).resolves.toEqual({});
    } finally {
      await safeFetch.close();
    }
  });

  it("lets the SDK refresh a rejected token, persist rotation, and retry the MCP request", async () => {
    const resourceHeaders: string[] = [];
    const persisted: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init);
        const url = new URL(request.url);
        if (url.href === "https://auth.example.test/token") {
          return Response.json({
            access_token: "fresh-access",
            refresh_token: "rotated-refresh",
            token_type: "bearer",
            expires_in: 3600,
          });
        }
        if (url.href === "https://mcp.example.test/mcp") {
          const authorization = request.headers.get("authorization") ?? "";
          resourceHeaders.push(authorization);
          if (authorization === "Bearer stale-access") {
            return new Response(null, { status: 401, headers: { "WWW-Authenticate": "Bearer" } });
          }
          const message = JSON.parse(await request.text()) as { id?: number; method?: string };
          if (message.method === "initialize") {
            return Response.json({
              jsonrpc: "2.0",
              id: message.id,
              result: {
                protocolVersion: "2025-11-25",
                capabilities: {},
                serverInfo: { name: "test", version: "1" },
              },
            });
          }
          return new Response(null, { status: 202 });
        }
        throw new Error(`Unexpected request: ${request.method} ${url}`);
      }),
    );
    const provider = new StoredMcpOAuthProvider(
      "server-1",
      {
        oauth: {
          redirectUri: "http://127.0.0.1:5173/mcp/oauth/callback",
          tokens: { access_token: "stale-access", refresh_token: "refresh", token_type: "bearer" },
          clientInformation: { client_id: "client-1" },
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
              grant_types_supported: ["authorization_code", "refresh_token"],
            },
          },
        },
      },
      async (material) => {
        persisted.push(structuredClone(material));
      },
    );
    const session = new McpSession();

    await session.connectRemote({
      url: "https://mcp.example.test/mcp",
      authProvider: provider,
      fallbackToSse: false,
      network: TEST_NETWORK,
    });

    expect(resourceHeaders[0]).toBe("Bearer stale-access");
    expect(resourceHeaders.slice(1)).not.toHaveLength(0);
    expect(resourceHeaders.slice(1).every((value) => value === "Bearer fresh-access")).toBe(true);
    expect(provider.tokens()).toMatchObject({
      access_token: "fresh-access",
      refresh_token: "rotated-refresh",
    });
    expect(persisted).toHaveLength(1);
    await session.close();
  });

  it("invalidates a dead refresh token and surfaces reconnect instead of silently losing tools", async () => {
    const persisted: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init);
        if (request.url === "https://auth.example.test/token") {
          return Response.json(
            { error: "invalid_grant", error_description: "refresh token revoked" },
            { status: 400 },
          );
        }
        if (request.url === "https://mcp.example.test/mcp") {
          return new Response(null, { status: 401, headers: { "WWW-Authenticate": "Bearer" } });
        }
        throw new Error(`Unexpected request: ${request.method} ${request.url}`);
      }),
    );
    const provider = new StoredMcpOAuthProvider(
      "server-1",
      {
        oauth: {
          redirectUri: "http://127.0.0.1:5173/mcp/oauth/callback",
          tokens: {
            access_token: "stale-access",
            refresh_token: "dead-refresh",
            token_type: "bearer",
          },
          clientInformation: { client_id: "client-1" },
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
              grant_types_supported: ["authorization_code", "refresh_token"],
            },
          },
        },
      },
      async (material) => {
        persisted.push(structuredClone(material));
      },
    );
    const session = new McpSession();

    await expect(
      session.connectRemote({
        url: "https://mcp.example.test/mcp",
        authProvider: provider,
        fallbackToSse: false,
        network: TEST_NETWORK,
      }),
    ).rejects.toThrow("Reconnect this server");

    expect(provider.tokens()).toBeUndefined();
    expect(persisted.length).toBeGreaterThanOrEqual(1);
  });

  // Real HTTP on purpose: undici drops the whole request ("fetch failed",
  // cause "expected non-null body source") when a stream-bodied POST meets a
  // server that answers 401 without draining the body — the exact shape of an
  // OAuth challenge. A stubbed fetch can never catch this.
  it("receives the OAuth 401 challenge from a server that rejects before reading the request body", async () => {
    const server = createServer((req, res) => {
      if (req.method !== "POST" || !req.url?.startsWith("/mcp")) {
        res.statusCode = 404;
        res.end();
        return;
      }
      res.statusCode = 401;
      res.setHeader("WWW-Authenticate", "Bearer");
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const provider = new StoredMcpOAuthProvider(
      "server-1",
      {
        oauth: {
          redirectUri: "http://127.0.0.1:5173/mcp/oauth/callback",
          clientInformation: { client_id: "client-1" },
          discoveryState: {
            authorizationServerUrl: `http://127.0.0.1:${port}`,
            authorizationServerMetadata: {
              issuer: `http://127.0.0.1:${port}`,
              authorization_endpoint: `http://127.0.0.1:${port}/authorize`,
              token_endpoint: `http://127.0.0.1:${port}/token`,
              response_types_supported: ["code"],
            },
          },
        },
      },
      async () => {},
    );
    const session = new McpSession();
    try {
      await expect(
        session.connectRemote({
          url: `http://127.0.0.1:${port}/mcp`,
          authProvider: provider,
          fallbackToSse: false,
          urlPolicy: { allowHttpLocalhost: true },
        }),
      ).rejects.toThrow("Reconnect this server");
    } finally {
      await session.close();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("strips sensitive headers when falling back to the endpoint origin", async () => {
    const seen: Record<string, string>[] = [];
    const inner = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (request.url === "https://private.example.test/data") throw new TypeError("fetch failed");
      seen.push(Object.fromEntries(new Headers(init?.headers).entries()));
      return Response.json({ ok: true });
    });
    const fallback = withEndpointOriginFallback(
      "https://endpoint.example.test",
      inner as typeof fetch,
    );

    const response = await fallback("https://private.example.test/data", {
      headers: { authorization: "Bearer secret", "x-custom": "keep-me" },
    });

    expect(response.ok).toBe(true);
    const retry = seen[0] ?? {};
    expect(retry.authorization).toBeUndefined();
    expect(retry.cookie).toBeUndefined();
    expect(retry["x-custom"]).toBe("keep-me");
  });

  it("keeps sensitive headers on same-origin and first-attempt requests", async () => {
    const inner = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      return Response.json({ authorization: request.headers.get("authorization") });
    });
    const fallback = withEndpointOriginFallback(
      "https://endpoint.example.test",
      inner as typeof fetch,
    );

    const direct = await fallback("https://endpoint.example.test/api", {
      headers: { authorization: "Bearer secret" },
    });
    await expect(direct.json()).resolves.toEqual({ authorization: "Bearer secret" });
  });

  it("strips configured credentials from localhost HTTP requests", async () => {
    let seen: Record<string, string> = {};
    const safeFetch = secureFetch(
      new URL("http://localhost:8123/mcp"),
      { allowHttpLocalhost: true },
      {
        allowedHeaders: ["authorization", "x-api-key"],
        headers: { Authorization: "Bearer stored", "X-Api-Key": "stored-key" },
      },
      {
        fetch: vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
          const request = input instanceof Request ? input : new Request(input, init);
          seen = Object.fromEntries(request.headers.entries());
          return Response.json({ ok: true });
        }),
      },
    );

    await safeFetch("http://localhost:8123/mcp", {
      method: "POST",
      headers: {
        Authorization: "Bearer sdk",
        "X-Api-Key": "sdk-key",
        "Content-Type": "application/json",
      },
      body: "{}",
    });

    expect(seen.authorization).toBeUndefined();
    expect(seen["x-api-key"]).toBeUndefined();
    expect(seen["content-type"]).toBe("application/json");
  });

  it("keeps configured credentials for HTTPS requests", async () => {
    let seen: Record<string, string> = {};
    const safeFetch = secureFetch(
      new URL("https://mcp.example.test/mcp"),
      {},
      {
        allowedHeaders: ["authorization", "x-api-key"],
        headers: { Authorization: "Bearer stored", "X-Api-Key": "stored-key" },
      },
      {
        resolveHostname: TEST_NETWORK.resolveHostname,
        fetch: vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
          const request = input instanceof Request ? input : new Request(input, init);
          seen = Object.fromEntries(request.headers.entries());
          return Response.json({ ok: true });
        }),
      },
    );

    await safeFetch("https://mcp.example.test/mcp", { method: "POST", body: "{}" });

    expect(seen.authorization).toBe("Bearer stored");
    expect(seen["x-api-key"]).toBe("stored-key");
  });

  it("drops request headers outside the configured allowlist", async () => {
    let seen: Record<string, string> = {};
    const safeFetch = secureFetch(
      new URL("https://mcp.example.test/mcp"),
      {},
      { allowedHeaders: ["accept"] },
      {
        resolveHostname: TEST_NETWORK.resolveHostname,
        fetch: vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
          const request = input instanceof Request ? input : new Request(input, init);
          seen = Object.fromEntries(request.headers.entries());
          return Response.json({ ok: true });
        }),
      },
    );

    await safeFetch("https://mcp.example.test/mcp", {
      headers: { Accept: "application/json", "X-Untrusted": "drop-me" },
    });

    expect(seen.accept).toBe("application/json");
    expect(seen["x-untrusted"]).toBeUndefined();
  });

  it("honours init header replacement for Request inputs", async () => {
    let seen: Record<string, string> = {};
    const safeFetch = secureFetch(
      new URL("https://mcp.example.test/mcp"),
      {},
      {},
      {
        resolveHostname: TEST_NETWORK.resolveHostname,
        fetch: vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
          const request = input instanceof Request ? input : new Request(input, init);
          seen = Object.fromEntries(request.headers.entries());
          return Response.json({ ok: true });
        }),
      },
    );
    const request = new Request("https://mcp.example.test/mcp", {
      headers: { Authorization: "Bearer stale", "Content-Type": "application/json" },
    });

    await safeFetch(request, { headers: { Accept: "application/json" } });

    expect(seen.accept).toBe("application/json");
    expect(seen.authorization).toBeUndefined();
    expect(seen["content-type"]).toBeUndefined();
  });

  it("does not forward configured resource credentials to another origin", async () => {
    let seen: Record<string, string> = {};
    const safeFetch = secureFetch(
      new URL("https://mcp.example.test/mcp"),
      {},
      { headers: { Authorization: "Bearer stored", "X-Api-Key": "stored-key" } },
      {
        resolveHostname: TEST_NETWORK.resolveHostname,
        fetch: vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
          const request = input instanceof Request ? input : new Request(input, init);
          seen = Object.fromEntries(request.headers.entries());
          return Response.json({ ok: true });
        }),
      },
    );

    await safeFetch("https://auth.example.test/token", {
      headers: { Authorization: "Bearer stored", "X-Api-Key": "stored-key" },
    });

    expect(seen.authorization).toBeUndefined();
    expect(seen["x-api-key"]).toBeUndefined();
  });

  it("does not forward configured credential values under another header name", async () => {
    let seen: Record<string, string> = {};
    const safeFetch = secureFetch(
      new URL("https://mcp.example.test/mcp"),
      {},
      { headers: { "X-Api-Key": "stored-key" } },
      {
        resolveHostname: TEST_NETWORK.resolveHostname,
        fetch: vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
          const request = input instanceof Request ? input : new Request(input, init);
          seen = Object.fromEntries(request.headers.entries());
          return Response.json({ ok: true });
        }),
      },
    );

    await safeFetch("https://auth.example.test/token", {
      headers: { Authorization: "stored-key" },
    });

    expect(seen.authorization).toBeUndefined();
  });

  it("never retries a failed write against the endpoint origin", async () => {
    const inner = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const fallback = withEndpointOriginFallback(
      "https://endpoint.example.test",
      inner as typeof fetch,
    );

    await expect(
      fallback("https://private.example.test/register", {
        method: "POST",
        body: "client_secret=secret",
      }),
    ).rejects.toThrow("fetch failed");
    expect(inner).toHaveBeenCalledTimes(1);
  });
});
