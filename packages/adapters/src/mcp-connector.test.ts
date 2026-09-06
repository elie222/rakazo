import { afterEach, describe, expect, it, vi } from "vitest";
import { allowlistDrift, McpConnector } from "./mcp-connector.js";
import { type McpOAuthBroker, StoredMcpOAuthProvider } from "./mcp-oauth.js";

afterEach(() => vi.unstubAllGlobals());

const SERVER = {
  id: "server-1",
  slug: "demo",
  transport: "streamable_http",
  endpoint: "https://mcp.example.test/mcp",
  secretId: null,
  args: [],
  revision: 1,
};

const ASSIGNMENT = {
  botId: "bot-1",
  serverId: "server-1",
  spaceId: "w1",
  userId: "u1",
  allowAllTools: true,
  allowedTools: [],
  server: SERVER,
};

function mcpFetch(
  state: {
    failNext: boolean;
    initializations: number;
    headers?: Record<string, string>[];
    tools?: Array<{ name: string; description?: string; inputSchema: Record<string, unknown> }>;
    calls?: string[];
  },
  expectedUrl = "https://mcp.example.test/mcp",
) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    state.headers?.push(Object.fromEntries(request.headers.entries()));
    if (new URL(request.url).href !== expectedUrl)
      throw new Error(`Unexpected request: ${request.url}`);
    if (request.method !== "POST") return new Response(null, { status: 405 });
    if (state.failNext) return new Response("boom", { status: 500 });
    const message = JSON.parse(await request.text()) as {
      id?: number;
      method?: string;
      params?: { name?: string };
    };
    if (message.method === "initialize") {
      state.initializations += 1;
      return Response.json({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: "2025-11-25",
          capabilities: { tools: {} },
          serverInfo: { name: "test", version: "1" },
        },
      });
    }
    if (message.method === "tools/list") {
      return Response.json({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          tools: state.tools ?? [{ name: "echo", inputSchema: { type: "object" } }],
        },
      });
    }
    if (message.method === "tools/call") {
      if (message.params?.name) state.calls?.push(message.params.name);
      return Response.json({
        jsonrpc: "2.0",
        id: message.id,
        result: { content: [{ type: "text", text: "ok" }] },
      });
    }
    return new Response(null, { status: 202 });
  });
}

describe("MCP connector session cache", () => {
  it("keeps large MCP schemas out of the initial runtime tool catalog", async () => {
    const state = {
      failNext: false,
      initializations: 0,
      tools: Array.from({ length: 30 }, (_, index) => ({
        name: `tool_${String(index).padStart(2, "0")}`,
        description: `Tool ${index}`,
        inputSchema: {
          type: "object",
          properties: { value: { type: "string", description: `schema-marker-${index}` } },
          required: ["value"],
        },
      })),
    };
    vi.stubGlobal("fetch", mcpFetch(state));
    const prisma = {
      botMcpServer: {
        findMany: vi.fn().mockResolvedValue([ASSIGNMENT]),
        findFirst: vi.fn().mockResolvedValue(ASSIGNMENT),
      },
    };
    const connector = new McpConnector(prisma as never, {} as never, {
      network: { resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }] },
    });
    const context = {
      spaceId: "w1",
      userId: "u1",
      botId: "bot-1",
      signal: new AbortController().signal,
    } as never;

    const tools = await connector.discoverTools(context);

    expect(tools).toHaveLength(3);
    expect(tools.map((tool) => tool.name)).toEqual([
      "mcp_search_tools",
      "mcp_load_tool",
      "mcp_execute_tool",
    ]);
    expect(JSON.stringify(tools)).not.toContain("schema-marker");
    await connector.close();
  });

  it("exposes 20 MCP tools directly and switches at 21", async () => {
    const context = {
      spaceId: "w1",
      userId: "u1",
      botId: "bot-1",
      signal: new AbortController().signal,
    } as never;
    for (const count of [20, 21]) {
      const state = {
        failNext: false,
        initializations: 0,
        tools: Array.from({ length: count }, (_, index) => ({
          name: `tool_${index}`,
          inputSchema: { type: "object" },
        })),
      };
      vi.stubGlobal("fetch", mcpFetch(state));
      const connector = new McpConnector(
        {
          botMcpServer: {
            findMany: vi.fn().mockResolvedValue([ASSIGNMENT]),
            findFirst: vi.fn().mockResolvedValue(ASSIGNMENT),
          },
        } as never,
        {} as never,
        { network: { resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }] } },
      );
      const tools = await connector.discoverTools(context);
      if (count === 20) {
        expect(tools).toHaveLength(20);
        expect(tools[0]?.name).toMatch(/^mcp__demo__/);
      } else {
        expect(tools.map((tool) => tool.name)).toEqual([
          "mcp_search_tools",
          "mcp_load_tool",
          "mcp_execute_tool",
        ]);
      }
      await connector.close();
    }
  });

  it("returns no tools when the MCP catalog is empty", async () => {
    const connector = new McpConnector(
      { botMcpServer: { findMany: vi.fn().mockResolvedValue([]) } } as never,
      {} as never,
    );
    await expect(
      connector.discoverTools({
        spaceId: "w1",
        userId: "u1",
        botId: "bot-1",
        signal: new AbortController().signal,
      } as never),
    ).resolves.toEqual([]);
    await connector.close();
  });

  it("searches, loads, validates, authorizes, and executes one large-catalog tool", async () => {
    const state = {
      failNext: false,
      initializations: 0,
      calls: [] as string[],
      tools: Array.from({ length: 30 }, (_, index) => ({
        name: `tool_${String(index).padStart(2, "0")}`,
        description: index === 29 ? "Find the final report" : `Utility ${index}`,
        inputSchema: {
          type: "object",
          properties: { value: { type: "string" } },
          required: ["value"],
          additionalProperties: false,
        },
      })),
    };
    vi.stubGlobal("fetch", mcpFetch(state));
    const prisma = {
      botMcpServer: {
        findMany: vi.fn().mockResolvedValue([ASSIGNMENT]),
        findFirst: vi.fn().mockResolvedValue(ASSIGNMENT),
      },
    };
    const connector = new McpConnector(prisma as never, {} as never, {
      network: { resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }] },
    });
    const context = {
      spaceId: "w1",
      userId: "u1",
      botId: "bot-1",
      signal: new AbortController().signal,
    } as never;
    const [search, load, execute] = await connector.discoverTools(context);
    const collect = async (call: Parameters<McpConnector["execute"]>[0]) => {
      const events: unknown[] = [];
      for await (const event of connector.execute(call as never, context)) events.push(event);
      return events;
    };

    const searched = await collect({
      tool: search!.name,
      args: { query: "final report", limit: 2 },
      executionId: "search",
      route: search!.route,
    });
    expect(searched).toEqual([
      {
        type: "result",
        data: {
          tools: [
            {
              id: "server-1:tool_29",
              name: "mcp__demo__tool_29",
              description: "Find the final report",
              readOnly: false,
            },
          ],
        },
      },
    ]);
    expect(JSON.stringify(searched)).not.toContain("inputSchema");

    const indexed = await collect({
      tool: search!.name,
      args: {},
      executionId: "index",
      route: search!.route,
    });
    expect(indexed).toEqual([
      {
        type: "result",
        data: {
          index: [
            {
              group: "demo",
              names: Array.from(
                { length: 30 },
                (_, index) => `tool_${String(index).padStart(2, "0")}`,
              ),
            },
          ],
        },
      },
    ]);
    expect(JSON.stringify(indexed)).not.toContain("inputSchema");
    expect(search!.description).toContain("demo:");
    expect(search!.description).toContain("tool_00");

    const expanded = await collect({
      tool: search!.name,
      args: { group: "demo" },
      executionId: "group",
      route: search!.route,
    });
    expect(expanded).toEqual([
      {
        type: "result",
        data: {
          group: "demo",
          names: Array.from({ length: 30 }, (_, index) => `tool_${String(index).padStart(2, "0")}`),
        },
      },
    ]);

    const loaded = await collect({
      tool: load!.name,
      args: { id: "server-1:tool_29" },
      executionId: "load",
      route: load!.route,
    });
    expect(loaded).toEqual([
      expect.objectContaining({
        type: "result",
        data: expect.objectContaining({
          id: "server-1:tool_29",
          inputSchema: expect.objectContaining({ required: ["value"] }),
        }),
      }),
    ]);

    await expect(
      connector.resolveCall(
        {
          tool: execute!.name,
          args: { id: "mcp__demo__missing", arguments: { value: "x" } },
          executionId: "unknown",
          route: execute!.route,
        },
        context,
      ),
    ).rejects.toThrow("unknown or not authorized");
    await expect(
      connector.resolveCall(
        {
          tool: execute!.name,
          args: { id: "server-1:tool_29", arguments: {} },
          executionId: "invalid",
          route: execute!.route,
        },
        context,
      ),
    ).rejects.toThrow("arguments are invalid");

    const resolved = await connector.resolveCall(
      {
        tool: execute!.name,
        args: { id: "server-1:tool_29", arguments: { value: "ok" } },
        executionId: "execute",
        route: execute!.route,
      },
      context,
    );
    expect(resolved).toMatchObject({
      tool: { name: "mcp__demo__tool_29" },
      call: {
        tool: "mcp__demo__tool_29",
        args: { value: "ok" },
        route: { connectorId: "mcp", resourceId: "server-1", toolName: "tool_29" },
      },
    });
    expect(await collect(resolved!.call)).toMatchObject([{ type: "result" }]);
    expect(state.calls).toEqual(["tool_29"]);
    await connector.close();
  });

  it("executes authoritative MCP tools whose names match catalog controls", async () => {
    const state = {
      failNext: false,
      initializations: 0,
      calls: [] as string[],
      tools: ["__catalog_search", "__catalog_load", "__catalog_execute"].map((name) => ({
        name,
        inputSchema: { type: "object" },
      })),
    };
    vi.stubGlobal("fetch", mcpFetch(state));
    const prisma = {
      botMcpServer: {
        findMany: vi.fn().mockResolvedValue([ASSIGNMENT]),
        findFirst: vi.fn().mockResolvedValue(ASSIGNMENT),
      },
    };
    const connector = new McpConnector(prisma as never, {} as never, {
      network: { resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }] },
    });
    const context = {
      spaceId: "w1",
      userId: "u1",
      botId: "bot-1",
      signal: new AbortController().signal,
    } as never;

    for (const tool of await connector.discoverTools(context)) {
      const call = { tool: tool.name, args: {}, executionId: tool.name, route: tool.route };
      await expect(connector.resolveCall(call, context)).resolves.toBeUndefined();
      const events = [];
      for await (const event of connector.execute(call, context)) events.push(event);
      expect(events).toMatchObject([{ type: "result" }]);
    }
    expect(state.calls).toEqual(["__catalog_search", "__catalog_load", "__catalog_execute"]);
    await connector.close();
  });

  it.each(["localhost", "127.0.0.1", "[::1]"])(
    "blocks OAuth rediscovery to HTTP %s after invalid_client from a public server",
    async (host) => {
      const requests: Request[] = [];
      const metadataUrl = `http://${host}:8123/private-probe`;
      const provider = new StoredMcpOAuthProvider(
        "server-1",
        {
          oauth: {
            redirectUri: "https://app.example.test/mcp/oauth/callback",
            tokens: {
              access_token: "fake-stale-access",
              refresh_token: "fake-refresh",
              token_type: "bearer",
            },
            clientInformation: { client_id: "fake-client" },
            discoveryState: {
              authorizationServerUrl: "https://auth.example.test",
              resourceMetadata: {
                resource: SERVER.endpoint,
                authorization_servers: ["https://auth.example.test"],
              },
              authorizationServerMetadata: {
                issuer: "https://auth.example.test",
                authorization_endpoint: "https://auth.example.test/authorize",
                token_endpoint: "https://auth.example.test/token",
                response_types_supported: ["code"],
              },
            },
          },
        },
        async () => undefined,
      );
      const invalidate = vi.spyOn(provider, "invalidateCredentials");
      const connector = new McpConnector(
        { botMcpServer: { findMany: vi.fn().mockResolvedValue([ASSIGNMENT]) } } as never,
        {} as never,
        {
          network: {
            resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }],
            fetch: vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
              const request = new Request(input, init);
              requests.push(request);
              if (request.url === SERVER.endpoint) {
                return new Response(null, {
                  status: 401,
                  headers: { "WWW-Authenticate": `Bearer resource_metadata="${metadataUrl}"` },
                });
              }
              if (request.url === "https://auth.example.test/token") {
                return Response.json({ error: "invalid_client" }, { status: 400 });
              }
              return new Response(null, { status: 404 });
            }),
          },
        },
        { providerFor: vi.fn().mockResolvedValue(provider) } as unknown as McpOAuthBroker,
      );

      try {
        await expect(
          connector.discoverTools({
            spaceId: "w1",
            userId: "u1",
            botId: "bot-1",
            signal: new AbortController().signal,
          } as never),
        ).resolves.toEqual([]);

        expect(requests.slice(0, 2).map((request) => `${request.method} ${request.url}`)).toEqual([
          `POST ${SERVER.endpoint}`,
          "POST https://auth.example.test/token",
        ]);
        expect(invalidate).toHaveBeenCalledWith("all");
        expect(requests.some((request) => request.url === metadataUrl)).toBe(false);
        // The endpoint-origin compatibility retry remains allowed, through remote policy.
        expect(
          requests.some((request) => request.url === "https://mcp.example.test/private-probe"),
        ).toBe(true);
        expect(requests.every((request) => new URL(request.url).protocol === "https:")).toBe(true);
      } finally {
        await connector.close();
      }
    },
  );

  it("connects to an explicitly configured localhost HTTP server", async () => {
    const state = { failNext: false, initializations: 0 };
    const localAssignment = {
      ...ASSIGNMENT,
      server: { ...SERVER, endpoint: "http://localhost:8123/api/mcp" },
    };
    vi.stubGlobal("fetch", mcpFetch(state, "http://localhost:8123/api/mcp"));
    const prisma = {
      botMcpServer: { findMany: vi.fn().mockResolvedValue([localAssignment]) },
    };
    const connector = new McpConnector(prisma as never, {} as never);

    const tools = await connector.discoverTools({
      spaceId: "w1",
      userId: "u1",
      botId: "bot-1",
      signal: new AbortController().signal,
    } as never);

    expect(tools.map((tool) => tool.name)).toEqual(["mcp__demo__echo"]);
    await connector.close();
  });

  it("sends stored credentials to an explicitly configured localhost HTTP server", async () => {
    const state = { failNext: false, initializations: 0, headers: [] as Record<string, string>[] };
    const localAssignment = {
      ...ASSIGNMENT,
      server: { ...SERVER, endpoint: "http://localhost:8123/api/mcp", secretId: "secret-1" },
    };
    vi.stubGlobal("fetch", mcpFetch(state, "http://localhost:8123/api/mcp"));
    const prisma = {
      botMcpServer: { findMany: vi.fn().mockResolvedValue([localAssignment]) },
      secret: { findFirst: vi.fn().mockResolvedValue({ id: "secret-1", ciphertext: "encrypted" }) },
    };
    const connector = new McpConnector(
      prisma as never,
      {
        load: vi
          .fn()
          .mockReturnValue(
            JSON.stringify({ secret: "local-token", headers: { "X-Api-Key": "local-key" } }),
          ),
      } as never,
    );

    await connector.discoverTools({
      spaceId: "w1",
      userId: "u1",
      botId: "bot-1",
      signal: new AbortController().signal,
    } as never);

    expect(state.headers[0]?.authorization).toBe("Bearer local-token");
    expect(state.headers[0]?.["x-api-key"]).toBe("local-key");
    await connector.close();
  });

  it("evicts a session after a failed call so the next call reconnects instead of reusing a dead session", async () => {
    const state = { failNext: false, initializations: 0 };
    vi.stubGlobal("fetch", mcpFetch(state));
    const prisma = {
      botMcpServer: {
        findMany: vi.fn().mockResolvedValue([ASSIGNMENT]),
        findFirst: vi.fn().mockResolvedValue(ASSIGNMENT),
      },
    };
    const connector = new McpConnector(prisma as never, {} as never, {
      network: {
        resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }],
      },
    });
    const context = {
      spaceId: "w1",
      userId: "u1",
      botId: "bot-1",
      signal: new AbortController().signal,
    } as never;
    const call = {
      tool: "mcp__demo__echo",
      args: {},
      route: { connectorId: "mcp", resourceId: "server-1", toolName: "echo" },
    } as never;

    const tools = await connector.discoverTools(context);
    expect(tools.map((tool) => tool.name)).toEqual(["mcp__demo__echo"]);
    expect(state.initializations).toBe(1);

    state.failNext = true;
    const failed: unknown[] = [];
    for await (const event of connector.execute(call, context)) failed.push(event);
    expect(failed).toMatchObject([{ type: "error" }]);

    state.failNext = false;
    const events: unknown[] = [];
    for await (const event of connector.execute(call, context)) events.push(event);
    expect(events).toMatchObject([{ type: "result" }]);
    expect(state.initializations).toBe(2);

    await connector.close();
  });

  it("does not reuse one session across workspaces", async () => {
    const state = { failNext: false, initializations: 0 };
    vi.stubGlobal("fetch", mcpFetch(state));
    const prisma = {
      botMcpServer: {
        findMany: vi.fn().mockResolvedValue([ASSIGNMENT]),
        findFirst: vi.fn().mockResolvedValue(ASSIGNMENT),
      },
    };
    const connector = new McpConnector(prisma as never, {} as never, {
      network: { resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }] },
    });
    const contextFor = (spaceId: string, userId: string) =>
      ({ spaceId, userId, botId: "bot-1", signal: new AbortController().signal }) as never;

    await connector.discoverTools(contextFor("w1", "u1"));
    expect(state.initializations).toBe(1);

    await connector.discoverTools(contextFor("w1", "u2"));
    expect(state.initializations).toBe(2);

    await connector.discoverTools(contextFor("w2", "u1"));
    expect(state.initializations).toBe(3);

    await connector.discoverTools(contextFor("w1", "u1"));
    expect(state.initializations).toBe(3);

    await connector.close();
  });
});

describe("allowlistDrift", () => {
  it("names the allowed tools the server no longer offers", () => {
    const offered = [{ name: "echo" }, { name: "upper" }];
    expect(allowlistDrift(["echo", "vanished_tool"], offered)).toEqual({
      missing: ["vanished_tool"],
      offered: 2,
      stringAllowedCount: 2,
    });
    expect(allowlistDrift(["echo"], offered).missing).toEqual([]);
    // allowedTools is a Json column, so it can hold anything: it must not throw.
    expect(allowlistDrift(null, offered)).toEqual({
      missing: [],
      offered: 2,
      stringAllowedCount: 0,
    });
    // Non-string JSON values are ignored for both missing and the warning ratio.
    expect(allowlistDrift([42, "vanished_tool"], offered)).toEqual({
      missing: ["vanished_tool"],
      offered: 2,
      stringAllowedCount: 1,
    });
  });
});
