import * as z from "zod";

export const McpTransportSchema = z.enum(["streamable_http", "sse", "stdio"]);
export type McpTransport = z.infer<typeof McpTransportSchema>;

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
  // HTTP field names are tokens (RFC 9110 section 5.6.2), including underscores.
  .record(z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/), z.string().max(4096))
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
  /** Access token expiry in epoch milliseconds, the form Google's token files use. */
  "expires_at",
  "scope",
  "token_type",
] as const;
export type McpOAuthEnvField = (typeof MCP_OAUTH_ENV_FIELDS)[number];

const OAUTH_ENV_REFERENCE = /\{\{\s*oauth\.([^{}]*?)\s*\}\}/g;

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
    const name = (match[1] ?? "").trim();
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
    resolved[key] = resolveMcpOAuthTemplate(value, values, key);
  }
  return resolved;
}

/** Replace OAuth references in one value or credential-file template; `label` names it in errors. */
export function resolveMcpOAuthTemplate(
  template: string,
  values: Partial<Record<McpOAuthEnvField, string>>,
  label: string,
): string {
  return template.replace(OAUTH_ENV_REFERENCE, (_reference, rawName: string) => {
    const name = rawName.trim();
    const field = isOAuthEnvField(name) ? values[name] : undefined;
    if (!field) throw new Error(`MCP OAuth value oauth.${name} is not available for ${label}`);
    return field;
  });
}

/**
 * Fill a credential-file template. When the file is JSON, values are escaped for the JSON
 * string they sit in, so a secret holding a quote or backslash keeps the file valid.
 */
export function resolveMcpOAuthFileTemplate(
  template: string,
  values: Partial<Record<McpOAuthEnvField, string>>,
  label: string,
): string {
  let json = false;
  try {
    JSON.parse(template.replace(OAUTH_ENV_REFERENCE, "0"));
    json = true;
  } catch {
    // Not JSON (e.g. an INI or plain token file): values go in as they are.
  }
  if (!json) return resolveMcpOAuthTemplate(template, values, label);
  const escaped = Object.fromEntries(
    Object.entries(values).map(([key, value]) => [
      key,
      value === undefined ? value : JSON.stringify(value).slice(1, -1),
    ]),
  ) as Partial<Record<McpOAuthEnvField, string>>;
  return resolveMcpOAuthTemplate(template, escaped, label);
}

/**
 * Credential files for stdio servers whose packages read a file path rather than
 * a value. The key is the env variable that receives the file's path; the value
 * is the file content template, which may use the same `{{oauth.*}}` references.
 */
export const McpStdioFilesSchema = z
  .record(z.string().regex(/^[A-Z_][A-Z0-9_]*$/), z.string().max(65536))
  .superRefine((value, ctx) => {
    if (Object.keys(value).length > 8) {
      ctx.addIssue({ code: "custom", message: "At most 8 credential files are allowed" });
    }
  });

/** Parameters the OAuth flow sets itself; extra authorization parameters may not override them. */
const MCP_OAUTH_FLOW_PARAMS = new Set([
  "response_type",
  "client_id",
  "redirect_uri",
  "scope",
  "state",
  "code_challenge",
  "code_challenge_method",
  "resource",
]);

/**
 * Extra parameters for the authorization request, in query-string form. Some
 * providers need them to issue a refresh token, e.g. Google's
 * `access_type=offline&prompt=consent`.
 */
export function parseMcpOAuthAuthorizationParams(value: string): Record<string, string> {
  const params: Record<string, string> = {};
  for (const [key, entry] of new URLSearchParams(value.trim().replace(/^\?/, ""))) {
    if (MCP_OAUTH_FLOW_PARAMS.has(key))
      throw new Error(`${key} is set by the OAuth flow and cannot be an extra parameter`);
    params[key] = entry;
  }
  return params;
}
