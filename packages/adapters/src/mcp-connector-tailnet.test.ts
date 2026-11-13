import { once } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { connect } from "node:net";
import type { AdapterContext } from "@rakazo/adapter-kit";
import { afterEach, describe, expect, it } from "vitest";
import { MCP_TAILNET_NO_BOT_MESSAGE, McpConnector } from "./mcp-connector.js";
import { EncryptedSecretStore } from "./secrets.js";
import { saveTailnetConnection, setTailnetBotAccess } from "./tailnet-connections.js";
import { tailnetDatabase } from "./tailnet-connections.test-support.js";
import { FakeTailnetNodeHost, TailscaleApiEmulator } from "./tailnet-emulator.js";
import { TailnetService } from "./tailnet-service.js";

const SECRET = "tskey-client-kTEST-secretvalue";
const ALICE = { userId: "alice", spaceId: "home" };
const secretStore = new EncryptedSecretStore("test-only-encryption-key");

const SERVER = {
  id: "server-1",
  slug: "homelab",
  name: "Home lab",
  transport: "streamable_http",
  endpoint: "http://mcp.tail1234.ts.net/mcp",
  secretId: null,
  args: [],
  revision: 1,
  allBots: false,
};

const closers: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

/** Answers the MCP requests a connector sends to list a server's tools. */
async function mcpServer(): Promise<{ port: number; requests: string[] }> {
  const requests: string[] = [];
  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    if (request.method !== "POST") return response.writeHead(405).end();
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const message = JSON.parse(Buffer.concat(chunks).toString()) as { id?: number; method: string };
    requests.push(message.method);
    const result =
      message.method === "initialize"
        ? {
            protocolVersion: "2025-11-25",
            capabilities: { tools: {} },
            serverInfo: { name: "homelab", version: "1" },
          }
        : message.method === "tools/list"
          ? { tools: [{ name: "status", inputSchema: { type: "object" } }] }
          : undefined;
    if (!result) return response.writeHead(202).end();
    response
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  closers.push(() => new Promise((resolve) => server.close(resolve)));
  return { port: (server.address() as AddressInfo).port, requests };
}

async function setup(options: { tailnetBots?: string[] } = {}) {
  const emulator = new TailscaleApiEmulator();
  emulator.addClient("client-a", { secret: SECRET, scopes: ["auth_keys"], tags: ["tag:rakazo"] });
  const nodes = new FakeTailnetNodeHost(emulator);
  const mcp = await mcpServer();
  const callers: string[] = [];
  // Only the tailnet reaches the MCP server; each connection is piped to it.
  nodes.serve({ host: "mcp.tail1234.ts.net", port: 80 }, (socket, from) => {
    callers.push(from.hostname);
    const upstream = connect(mcp.port, "127.0.0.1");
    socket.pipe(upstream).pipe(socket);
    socket.on("close", () => upstream.destroy());
  });
  const db = tailnetDatabase([
    { id: "helper", spaceId: "home", name: "Home Lab Helper" } as { id: string; spaceId: string },
  ]);
  const tailnet = new TailnetService({
    prisma: db.prisma,
    secretStore,
    nodeHost: nodes,
    fetch: emulator.fetch,
    sweepMs: 0,
  });
  closers.push(() => tailnet.close());
  await saveTailnetConnection({
    prisma: db.prisma,
    secretStore,
    scope: ALICE,
    config: { clientId: "client-a", clientSecret: SECRET, tag: "tag:rakazo" },
    verify: (config) => tailnet.verify(config, AbortSignal.timeout(5_000)),
  });
  for (const botId of options.tailnetBots ?? ["helper"]) {
    await setTailnetBotAccess({ prisma: db.prisma, scope: ALICE, botId, enabled: true });
  }
  const assignment = {
    botId: "helper",
    serverId: SERVER.id,
    spaceId: "home",
    userId: "alice",
    allowAllTools: true,
    allowedTools: [],
    server: SERVER,
  };
  const prisma = {
    ...db.prisma,
    mcpServer: {
      findMany: async () => [],
      findFirst: async () => null,
      updateMany: async () => ({ count: 1 }),
    },
    botMcpServer: {
      findMany: async () => [assignment],
      findFirst: async ({ where }: { where: { botId: { in: string[] } } }) =>
        where.botId.in.includes(assignment.botId) ? { botId: assignment.botId } : null,
    },
  };
  const connector = new McpConnector(prisma as never, secretStore, { tailnet });
  closers.push(() => connector.close());
  return { connector, emulator, callers, requests: mcp.requests };
}

function run(userId = "alice"): AdapterContext {
  return {
    operationId: "op",
    traceId: "op",
    spaceId: "home",
    userId,
    botId: "helper",
    runId: "run-1",
    signal: AbortSignal.timeout(10_000),
  };
}

describe("MCP servers on a member's tailnet", () => {
  it("lists the server's tools from the bot's own node", async () => {
    const { connector, callers, requests } = await setup();
    const tools = await connector.discoverTools(run());
    expect(tools.map((tool) => tool.name)).toEqual(["mcp__homelab__status"]);
    expect(requests).toContain("tools/list");
    expect(new Set(callers)).toEqual(new Set(["rakazo-home-lab-helper-helper"]));
  });

  it("reaches nothing from a run of a member who hasn't let the bot on", async () => {
    const { connector, emulator, requests } = await setup();
    const tools = await connector.discoverTools(run("bob"));
    expect(tools.map((tool) => tool.name)).toEqual(["mcp__homelab__unavailable"]);
    expect(tools[0]?.description).toContain("Tailnet access is off for this bot.");
    expect(requests).toEqual([]);
    expect(emulator.devices.size).toBe(0);
  });

  it("checks the server from a bot of the member's that may reach it", async () => {
    const reachable = await setup();
    expect(await reachable.connector.probe(SERVER as never, ALICE)).toMatchObject({
      status: "ok",
      toolCount: 1,
    });
    expect(reachable.callers).toEqual(expect.arrayContaining(["rakazo-home-lab-helper-helper"]));

    const unreachable = await setup({ tailnetBots: [] });
    expect(await unreachable.connector.probe(SERVER as never, ALICE)).toEqual({
      status: "error",
      message: MCP_TAILNET_NO_BOT_MESSAGE,
    });
    expect(unreachable.requests).toEqual([]);
  });
});
