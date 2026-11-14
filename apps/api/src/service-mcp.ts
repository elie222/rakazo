import { randomUUID } from "node:crypto";
import type { ServiceScope, ServiceTool } from "@rakazo/contracts";
import {
  buildServiceTools,
  SERVICE_API_PREFIX,
  SERVICE_BODY_MAX_BYTES,
  SERVICE_ROUTES,
} from "@rakazo/contracts";
import { readBoundedBody } from "./http-body.js";

/**
 * The service API as Model Context Protocol tools, for callers that are themselves agents.
 *
 * It holds no authority of its own. Every tool call is replayed as the plain HTTP request it
 * stands for, with the caller's own key, so scopes, bot limits, rate limits, idempotency and the
 * audit trail are decided in exactly one place.
 */
export const SERVICE_MCP_PATH = `${SERVICE_API_PREFIX}/mcp`;

const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
/** Room for the largest body a route accepts, with the arguments and envelope around it. */
const MAX_MESSAGE_BYTES =
  Math.max(
    ...Object.values(SERVICE_ROUTES).map((definition) =>
      "maxBodyBytes" in definition && definition.maxBodyBytes
        ? definition.maxBodyBytes
        : SERVICE_BODY_MAX_BYTES,
    ),
  ) + 65_536;
const PATH_VALUE = /^[A-Za-z0-9_-]{1,128}$/;
const TOOLS = buildServiceTools();

type Rpc = { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
type Me = { scopes: ServiceScope[]; botIds: string[] };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function reply(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  });
}

/** A refusal of the key itself is the transport's answer, not a tool's. */
const passThrough = (called: { response: Response; text: string }) =>
  new Response(called.text, { status: called.response.status, headers: called.response.headers });
const failure = (id: unknown, code: number, message: string) =>
  reply(200, { jsonrpc: "2.0", id: id ?? null, error: { code, message } });
const toolError = (id: unknown, text: string) =>
  reply(200, { jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text }] } });

function allowed(tool: ServiceTool, me: Me): boolean {
  const definition = SERVICE_ROUTES[tool.name];
  if (definition.scope && !me.scopes.includes(definition.scope)) return false;
  return !("spaceWide" in definition && definition.spaceWide && me.botIds.length > 0);
}

/** The HTTP request a tool call stands for, or the reason its arguments cannot make one. */
function requestFor(
  tool: ServiceTool,
  input: Record<string, unknown>,
  authorization: string,
  signal: AbortSignal,
): Request | string {
  const definition = SERVICE_ROUTES[tool.name];
  const used = new Set<string>();
  let invalid: string | null = null;
  const path = definition.path.replace(/:([A-Za-z]+)/g, (_, name: string) => {
    used.add(name);
    const value = input[name];
    if (typeof value !== "string" || !PATH_VALUE.test(value)) invalid ??= name;
    return String(value);
  });
  const url = new URL(`http://service.internal${SERVICE_API_PREFIX}${path}`);
  for (const key of tool.queryKeys) {
    used.add(key);
    const value = input[key];
    if (value === undefined) continue;
    if (!["string", "number", "boolean"].includes(typeof value)) invalid ??= key;
    url.searchParams.set(key, String(value));
  }
  const headers: Record<string, string> = { authorization };
  let body: string | undefined;
  if ("body" in definition && definition.body) {
    used.add("body");
    headers["content-type"] = "application/json";
    body = JSON.stringify(input.body ?? {});
  }
  if ("idempotency" in definition && definition.idempotency) {
    used.add("idempotencyKey");
    const key = input.idempotencyKey;
    if (key !== undefined && typeof key !== "string") invalid ??= "idempotencyKey";
    headers["idempotency-key"] = typeof key === "string" ? key : `mcp-${randomUUID()}`;
  }
  const unknown = Object.keys(input).find((key) => !used.has(key));
  if (unknown) return `Unknown argument "${unknown}".`;
  if (invalid) return `Argument "${invalid}" is missing or malformed.`;
  // The caller's disconnect reaches the route, which stops waiting on a prompt.
  return new Request(url, { method: definition.method, headers, body, signal });
}

export function serviceMcpHandler(inner: (request: Request) => Promise<Response>) {
  return async (request: Request): Promise<Response> => {
    if (request.method !== "POST") return reply(405, null, { allow: "POST" });
    const authorization = request.headers.get("authorization") ?? "";
    let message: Rpc;
    try {
      const raw = await readBoundedBody(request, MAX_MESSAGE_BYTES);
      if (raw === null) {
        return reply(413, {
          error: { code: "payload_too_large", message: "Body too large for this call." },
        });
      }
      message = JSON.parse(raw) as Rpc;
    } catch {
      return failure(null, -32700, "Parse error.");
    }
    if (!isRecord(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
      return failure(null, -32600, "One JSON-RPC 2.0 message per request.");
    }
    const { id, method } = message;
    if (id === undefined) return reply(202, null);

    const call = async (
      tool: ServiceTool,
      input: Record<string, unknown>,
    ): Promise<{ response: Response; text: string } | { error: string }> => {
      const built = requestFor(tool, input, authorization, request.signal);
      if (typeof built === "string") return { error: built };
      const response = await inner(built);
      return { response, text: await response.text() };
    };

    if (method === "tools/call") {
      const params = isRecord(message.params) ? message.params : {};
      const tool = TOOLS.find((candidate) => candidate.name === params.name);
      if (!tool) return failure(id, -32602, "Unknown tool.");
      const input = params.arguments ?? {};
      if (!isRecord(input)) return failure(id, -32602, "Arguments must be an object.");
      const called = await call(tool, input);
      if ("error" in called) return toolError(id, called.error);
      if (called.response.status === 401) return passThrough(called);
      if (called.response.status !== 200) return toolError(id, called.text);
      return reply(200, {
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: called.text }],
          structuredContent: JSON.parse(called.text),
        },
      });
    }

    // Everything else starts by proving the key, so nothing here answers a stranger.
    const me = TOOLS.find((tool) => tool.name === "me");
    const identity = me ? await call(me, {}) : null;
    if (!identity || "error" in identity || identity.response.status !== 200) {
      return identity && "response" in identity ? passThrough(identity) : reply(503, null);
    }
    if (method === "initialize") {
      const params = isRecord(message.params) ? message.params : {};
      const wanted = params.protocolVersion;
      return reply(200, {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion:
            typeof wanted === "string" && PROTOCOL_VERSIONS.includes(wanted)
              ? wanted
              : PROTOCOL_VERSIONS[0],
          capabilities: { tools: {} },
          serverInfo: { name: "service-api", version: "1" },
          instructions:
            "Each tool is one route of the service API and acts with the key that connected. " +
            "Messages you send are shown as sent with that key, never as typed by its owner.",
        },
      });
    }
    if (method === "ping") return reply(200, { jsonrpc: "2.0", id, result: {} });
    if (method === "tools/list") {
      const who = JSON.parse(identity.text) as Me;
      return reply(200, {
        jsonrpc: "2.0",
        id,
        result: {
          tools: TOOLS.filter((tool) => allowed(tool, who)).map(
            ({ name, description, inputSchema }) => ({ name, description, inputSchema }),
          ),
        },
      });
    }
    return failure(id, -32601, "Method not found.");
  };
}
