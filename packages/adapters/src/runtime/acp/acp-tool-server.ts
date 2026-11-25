import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { getLogger } from "@rakazo/logging";

export interface ToolServerTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolServer {
  /** The MCP server entry the agent is given in `session/new`. */
  entry: {
    type: "http";
    name: string;
    url: string;
    headers: Array<{ name: string; value: string }>;
  };
  close(): Promise<void>;
}

/**
 * Lists this turn's Rakazo tools to the agent on a loopback-only MCP endpoint and hands every call
 * to `call`, which runs it the way Rakazo runs any tool, approvals included. A random bearer token
 * minted for the turn is the only way in, and the endpoint closes when the turn ends.
 */
export async function startToolServer(
  name: string,
  tools: readonly ToolServerTool[],
  call: (tool: string, args: Record<string, unknown>) => Promise<CallToolResult>,
): Promise<ToolServer> {
  const token = randomBytes(32).toString("base64url");
  const expected = Buffer.from(`Bearer ${token}`);
  const authorized = (header: string | undefined) => {
    const given = Buffer.from(header ?? "");
    return given.length === expected.length && timingSafeEqual(given, expected);
  };
  const protocol = () => {
    const server = new Server({ name, version: "1.0.0" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [...tools] }));
    server.setRequestHandler(CallToolRequestSchema, (request) =>
      call(request.params.name, request.params.arguments ?? {}),
    );
    return server;
  };
  const http = createServer((request, response) => {
    // Compared as text: a malformed request target must not throw before the token is checked.
    if ((request.url ?? "").split("?")[0] !== "/mcp") return void response.writeHead(404).end();
    if (!authorized(request.headers.authorization))
      return void response
        .writeHead(401, { "www-authenticate": 'Bearer error="invalid_token"' })
        .end();
    // Stateless: each POST is a whole exchange, and there is no stream to open.
    if (request.method !== "POST") return void response.writeHead(405, { allow: "POST" }).end();
    const server = protocol();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    response.on("close", () => {
      void transport.close();
      void server.close();
    });
    server
      .connect(transport)
      .then(() => transport.handleRequest(request, response))
      .catch((error: unknown) => {
        getLogger().warn("The agent CLI's tool endpoint failed a request", { error });
        if (!response.headersSent) response.writeHead(500).end();
      });
  });
  // A tool call can wait on a person far longer than Node's default request timeout.
  http.requestTimeout = 0;
  http.headersTimeout = 60_000;
  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(0, "127.0.0.1", () => resolve());
  });
  http.unref();
  const { port } = http.address() as AddressInfo;
  return {
    entry: {
      type: "http",
      name,
      url: `http://127.0.0.1:${port}/mcp`,
      headers: [{ name: "Authorization", value: `Bearer ${token}` }],
    },
    close: () =>
      new Promise<void>((resolve) => {
        http.closeAllConnections();
        http.close(() => resolve());
      }),
  };
}
