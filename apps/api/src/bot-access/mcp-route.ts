import type { PublicTask } from "@rakazo/contracts";
import type { Hono } from "hono";
import { requestBodyLimit } from "../http/request-body-limit.js";
import type { BotAccess, KeyCaller } from "./bot-access.js";
import { publicApiFailure } from "./bot-access.js";
import { BOT_ACCESS_TOOLS, DEFAULT_TOOL_WAIT_SECONDS } from "./bot-access.tool-definition.js";

export const MCP_PATH = "/api/mcp";
const MAX_MCP_BODY_BYTES = 1024 * 1024;

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

function result(value: Record<string, unknown>): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value };
}

/** A refusal the agent can act on is a tool error; anything else propagates as a server error. */
async function answer(run: () => Promise<Record<string, unknown>>): Promise<ToolResult> {
  try {
    return result(await run());
  } catch (error) {
    const failure = publicApiFailure(error);
    if (!failure) throw error;
    return { content: [{ type: "text", text: failure.message }], isError: true };
  }
}

/** Builds a server for one request: the protocol keeps no session, so any instance answers. */
async function mcpServer(access: BotAccess, caller: KeyCaller, signal: AbortSignal) {
  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
  const server = new McpServer({ name: "rakazo", version: "1.0.0" });
  const wait = (
    started: Parameters<BotAccess["waitForTask"]>[1],
    seconds = DEFAULT_TOOL_WAIT_SECONDS,
  ): Promise<PublicTask> => access.waitForTask(caller, started, seconds * 1000, signal);
  server.registerTool("list_bots", BOT_ACCESS_TOOLS.list_bots, () =>
    answer(async () => ({
      bots: (await access.listBots(caller)).map(({ id, name, space }) => ({ id, name, space })),
    })),
  );
  server.registerTool("create_task", BOT_ACCESS_TOOLS.create_task, (input) =>
    answer(async () => {
      const started = await access.createTask(caller, { bot: input.bot, text: input.message });
      return await wait(started, input.wait_seconds);
    }),
  );
  server.registerTool("get_task", BOT_ACCESS_TOOLS.get_task, (input) =>
    answer(async () => await wait(await access.getTask(caller, input.task_id), input.wait_seconds)),
  );
  server.registerTool("send_task_message", BOT_ACCESS_TOOLS.send_task_message, (input) =>
    answer(async () =>
      wait(await access.sendToTask(caller, input.task_id, input.message), input.wait_seconds),
    ),
  );
  return server;
}

/**
 * `/api/mcp`: a Streamable HTTP MCP server for agents holding one of the person's API keys, sent
 * as `Authorization: Bearer <key>`. Every request stands alone, answered with JSON.
 */
export function mountMcpRoute(app: Hono, access: BotAccess) {
  app.use(MCP_PATH, requestBodyLimit(MAX_MCP_BODY_BYTES));
  app.all(MCP_PATH, async (c) => {
    let caller: KeyCaller;
    try {
      caller = await access.authenticate(c.req.raw.headers);
    } catch (error) {
      const failure = publicApiFailure(error);
      if (!failure) throw error;
      return c.json(
        { jsonrpc: "2.0", error: { code: -32001, message: failure.message }, id: null },
        failure.status as 401,
        {
          ...(failure.status === 401 ? { "www-authenticate": 'Bearer realm="rakazo"' } : {}),
          ...(failure.retryAfterSeconds
            ? { "retry-after": String(failure.retryAfterSeconds) }
            : {}),
        },
      );
    }
    if (c.req.method !== "POST")
      return c.json(
        { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null },
        405,
        { allow: "POST" },
      );
    const { WebStandardStreamableHTTPServerTransport } = await import(
      "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
    );
    const server = await mcpServer(access, caller, c.req.raw.signal);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    try {
      return await transport.handleRequest(c.req.raw);
    } finally {
      await server.close();
    }
  });
}
