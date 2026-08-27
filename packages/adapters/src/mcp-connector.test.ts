import { afterEach, describe, expect, it, vi } from "vitest";
import { McpConnector } from "./mcp-connector.js";

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
  workspaceId: "w1",
  userId: "u1",
  allowAllTools: true,
  allowedTools: [],
  server: SERVER,
};

function mcpFetch(state: { failNext: boolean; initializations: number }) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    if (new URL(request.url).href !== "https://mcp.example.test/mcp")
      throw new Error(`Unexpected request: ${request.url}`);
    if (request.method !== "POST") return new Response(null, { status: 405 });
    if (state.failNext) return new Response("boom", { status: 500 });
    const message = JSON.parse(await request.text()) as { id?: number; method?: string };
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
        result: { tools: [{ name: "echo", inputSchema: { type: "object" } }] },
      });
    }
    if (message.method === "tools/call") {
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
      workspaceId: "w1",
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
    const contextFor = (workspaceId: string, userId: string) =>
      ({ workspaceId, userId, botId: "bot-1", signal: new AbortController().signal }) as never;

    await connector.discoverTools(contextFor("w1", "u1"));
    expect(state.initializations).toBe(1);

    await connector.discoverTools(contextFor("w2", "u2"));
    expect(state.initializations).toBe(2);

    await connector.discoverTools(contextFor("w1", "u1"));
    expect(state.initializations).toBe(2);

    await connector.close();
  });
});
