import * as z from "zod";

export const McpTransportSchema = z.enum(["streamable_http", "sse", "stdio"]);
export type McpTransport = z.infer<typeof McpTransportSchema>;

export function isLocalMcpHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    hostname === "::1"
  );
}

export const McpRemoteEndpointSchema = z
  .string()
  .max(2048)
  .url()
  .refine((value) => {
    try {
      if (value.endsWith("#")) return false;
      const url = new URL(value);
      if (url.username || url.password || url.hash) return false;
      // Persist HTTP(S). Runtime SSRF still requires HTTPS for public hosts and
      // blocks private LAN targets unless the deployment-owner escape is on.
      return url.protocol === "https:" || url.protocol === "http:";
    } catch {
      return false;
    }
  }, "MCP remote endpoint must be an HTTP(S) URL without credentials or a fragment");

export const McpHeadersSchema = z
  .record(z.string().regex(/^[A-Za-z0-9-]+$/), z.string().max(4096))
  .superRefine((value, ctx) => {
    if (Object.keys(value).length > 32) {
      ctx.addIssue({ code: "custom", message: "At most 32 headers are allowed" });
    }
  });

/**
 * Credentials a stdio MCP server can receive from its host. The MCP spec leaves
 * stdio servers out of the OAuth flow and has them read credentials from the
 * environment, so an env value may reference the host-held grant as
 * `{{oauth.access_token}}` (alone or inside other text, e.g. `Bearer {{oauth.access_token}}`).
 */
export const MCP_OAUTH_ENV_FIELDS = [
  "access_token",
  "refresh_token",
  "client_id",
  "client_secret",
] as const;
export type McpOAuthEnvField = (typeof MCP_OAUTH_ENV_FIELDS)[number];

const OAUTH_ENV_REFERENCE = /\{\{\s*oauth\.([A-Za-z0-9_]+)\s*\}\}/g;

function isOAuthEnvField(name: string): name is McpOAuthEnvField {
  return (MCP_OAUTH_ENV_FIELDS as readonly string[]).includes(name);
}

/** The OAuth fields an env value references, and any references that are not fields. */
export function mcpOAuthEnvReferences(value: string): {
  fields: McpOAuthEnvField[];
  unknown: string[];
} {
  const fields = new Set<McpOAuthEnvField>();
  const unknown = new Set<string>();
  for (const match of value.matchAll(OAUTH_ENV_REFERENCE)) {
    const name = match[1] ?? "";
    if (isOAuthEnvField(name)) fields.add(name);
    else unknown.add(name);
  }
  return { fields: [...fields], unknown: [...unknown] };
}

/**
 * Replace OAuth references in env values. Throws when a referenced field has no
 * value (for example a refresh token the provider never issued), so a server is
 * never started with a literal placeholder or an empty credential.
 */
export function resolveMcpOAuthEnv(
  env: Record<string, string>,
  values: Partial<Record<McpOAuthEnvField, string>>,
): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    resolved[key] = value.replace(OAUTH_ENV_REFERENCE, (_reference, name: string) => {
      const field = isOAuthEnvField(name) ? values[name] : undefined;
      if (!field) throw new Error(`MCP OAuth value oauth.${name} is not available for ${key}`);
      return field;
    });
  }
  return resolved;
}
