/** Shared logic for the agent-facing add_mcp_server tool. Pure and unit-tested;
 * the executor wires the parsed result into Prisma + the secret store. */

import { McpRemoteEndpointSchema, type McpTransport, McpTransportSchema } from "@rakazo/contracts";
import { deriveMcpSlug } from "@rakazo/core";
import { toStringRecord } from "./memory-provider-factory.js";

export { deriveMcpSlug } from "@rakazo/core";

const MAX_ENV_ENTRIES = 32;
const MAX_ARGS = 64;

export type ParsedMcpServerArgs = {
  slug: string;
  name: string;
  description: string;
  transport: McpTransport;
  endpoint?: string;
  command?: string;
  args: string[];
  env: Record<string, string>;
  headers: Record<string, string>;
  secret?: string;
  assignToSelf: boolean;
};

/** Returns undefined for anything that would fail server-side validation,
 * so the model gets a single actionable error instead of a partial create. */
export function parseMcpServerToolArgs(
  args: Record<string, unknown>,
): ParsedMcpServerArgs | undefined {
  const name = typeof args.name === "string" ? args.name.trim().slice(0, 120) : "";
  if (!name) return undefined;
  const parsedTransport = McpTransportSchema.safeParse(args.transport);
  if (!parsedTransport.success) return undefined;
  const transport = parsedTransport.data;

  let endpoint: string | undefined;
  if (transport !== "stdio") {
    endpoint = typeof args.endpoint === "string" ? args.endpoint.trim() : "";
    if (!McpRemoteEndpointSchema.safeParse(endpoint).success) return undefined;
  }

  const command =
    transport === "stdio"
      ? typeof args.command === "string"
        ? args.command.trim()
        : ""
      : undefined;
  if (transport === "stdio" && !command) return undefined;

  let toolArgs: string[] = [];
  if (Array.isArray(args.args)) {
    toolArgs = args.args
      .filter((item): item is string => typeof item === "string")
      .slice(0, MAX_ARGS);
  } else if (typeof args.args === "string") {
    toolArgs = args.args.split(/\s+/).filter(Boolean).slice(0, MAX_ARGS);
  }

  const env = toStringRecord(args.env);
  const headers = toStringRecord(args.headers);
  if (Object.keys(env).length > MAX_ENV_ENTRIES || Object.keys(headers).length > MAX_ENV_ENTRIES) {
    return undefined;
  }

  return {
    slug: deriveMcpSlug(name),
    name,
    description: typeof args.description === "string" ? args.description.slice(0, 2000) : "",
    transport,
    endpoint,
    command,
    args: toolArgs,
    env,
    headers,
    secret:
      typeof args.secret === "string" && args.secret ? args.secret.slice(0, 16384) : undefined,
    assignToSelf: args.assign_to_self !== false,
  };
}

/** Serialized credential blob for the encrypted secret store; null when the
 * server has no static credential material. */
export function buildMcpCredentialBlob(parsed: {
  secret?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
}): string | null {
  const env = parsed.env ?? {};
  const headers = parsed.headers ?? {};
  if (!parsed.secret && Object.keys(env).length === 0 && Object.keys(headers).length === 0) {
    return null;
  }
  return JSON.stringify({ secret: parsed.secret, env, headers });
}

/** Heuristic for whether the approval card should lead with OAuth: remote
 * servers without a static credential usually need browser authorization. */
export function needsOAuthProbe(parsed: {
  transport: string;
  secret?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
}): boolean {
  if (parsed.transport === "stdio") return false;
  const env = parsed.env ?? {};
  const headers = parsed.headers ?? {};
  return !parsed.secret && Object.keys(env).length === 0 && Object.keys(headers).length === 0;
}
