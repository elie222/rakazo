import type { McpServerConfigInput } from "@rakazo/contracts";

type McpOAuthClient = {
  client_id: string;
  client_secret?: string;
  /** Space-separated scopes to request. */
  scope?: string;
  /** Extra authorization request parameters, query-string form. */
  authorization_params?: string;
  /** Set on first use by McpOAuthBroker for a remote server, or by the user for
   * stdio; kept while the client is unchanged. */
  authorization_server?: string;
};

/** Shape of the encrypted MCP credential blob. `oauth` holds SDK OAuth state
 * (tokens, client registration, PKCE verifier) managed by McpOAuthBroker.
 * `oauthClient` is a client the user registered with the provider themselves. */
export type McpSecretMaterial = {
  secret?: string;
  env?: Record<string, string>;
  /** Credential file templates by the env variable that receives the file's path. */
  files?: Record<string, string>;
  headers?: Record<string, string>;
  oauthClient?: McpOAuthClient;
  oauth?: Record<string, unknown>;
};

export type McpMaterialUpdate =
  | { action: "keep" }
  | { action: "store"; material: McpSecretMaterial };

/** Compute the next encrypted credential blob for an MCP server update.
 *
 * - "keep": the update carries no credential data; leave the stored blob as is.
 * - "store": rewrite the blob. An empty material means credentials were
 *   cleared entirely — the caller should delete the secret row and null the
 *   server's secretId instead of storing an empty object.
 *
 * env/headers/files use full-replace semantics (the update payload is the
 * complete set), matching the create handler; files are kept when omitted and
 * only exist for stdio servers. OAuth state is preserved unless the
 * endpoint changed, since tokens issued for one endpoint must never be sent to
 * another server. */
export function buildMcpUpdateMaterial(
  existing: McpSecretMaterial,
  config: McpServerConfigInput,
  options: { clearOAuth?: boolean } = {},
): McpMaterialUpdate {
  const client = nextOAuthClient(
    existing.oauthClient,
    "oauthClient" in config ? config.oauthClient : undefined,
  );
  // Tokens are issued to one client, so a different client must authorize again.
  const clearOAuth = options.clearOAuth === true || client.changed;
  const material = clearOAuth ? { ...existing } : existing;
  const clearedOAuth = clearOAuth && (material.oauth !== undefined || client.changed);
  if (clearOAuth) delete material.oauth;
  if (client.changed) {
    if (client.next) material.oauthClient = client.next;
    else delete material.oauthClient;
  }
  const clearing = config.clearCredential === true;
  if (clearing) {
    return {
      action: "store",
      material: {
        ...(material.oauthClient ? { oauthClient: material.oauthClient } : {}),
        ...(material.oauth ? { oauth: material.oauth } : {}),
      },
    };
  }
  const secret = "secret" in config && config.secret ? config.secret : undefined;
  const env = "env" in config ? config.env : undefined;
  const headers = "headers" in config ? config.headers : undefined;
  const { files: storedFiles, ...withoutFiles } = material;
  const files = config.transport === "stdio" ? (config.files ?? storedFiles) : undefined;
  const hasFiles = files !== undefined && Object.keys(files).length > 0;
  const existingHasMaterial = Boolean(
    material.secret ||
      (material.env && Object.keys(material.env).length > 0) ||
      (storedFiles && Object.keys(storedFiles).length > 0) ||
      (material.headers && Object.keys(material.headers).length > 0) ||
      material.oauthClient ||
      material.oauth,
  );
  const suppliesMaterial = Boolean(
    secret ||
      (env && Object.keys(env).length > 0) ||
      (headers && Object.keys(headers).length > 0) ||
      hasFiles,
  );
  if (!existingHasMaterial && !suppliesMaterial) {
    return clearedOAuth ? { action: "store", material } : { action: "keep" };
  }
  return {
    action: "store",
    material: {
      ...withoutFiles,
      ...(secret ? { secret } : {}),
      ...(env !== undefined ? { env } : {}),
      ...(headers !== undefined ? { headers } : {}),
      ...(hasFiles ? { files } : {}),
    },
  };
}

/** Resolve the client an update asks for. A resent client ID without a secret
 * keeps the stored secret; a different client ID never inherits it. Any
 * difference in client, secret, scope, or authorization server is a change, and
 * an unchanged resend keeps the stored object, including a first-use binding. */
function nextOAuthClient(
  existing: McpOAuthClient | undefined,
  input:
    | {
        clientId: string;
        clientSecret?: string;
        scope?: string;
        authorizationServer?: string;
        authorizationParams?: string;
      }
    | null
    | undefined,
): { next?: McpOAuthClient; changed: boolean } {
  if (input === undefined) return { next: existing, changed: false };
  if (input === null) return { changed: existing !== undefined };
  const sameClient = existing?.client_id === input.clientId;
  const secret = input.clientSecret ?? (sameClient ? existing?.client_secret : undefined);
  const scope = input.scope || undefined;
  const authorizationParams = input.authorizationParams || undefined;
  const authorizationServer = input.authorizationServer
    ? new URL(input.authorizationServer).href
    : undefined;
  const unchanged =
    existing !== undefined &&
    sameClient &&
    secret === existing.client_secret &&
    scope === existing.scope &&
    authorizationParams === existing.authorization_params &&
    (authorizationServer === undefined || authorizationServer === existing.authorization_server);
  if (unchanged) return { next: existing, changed: false };
  return {
    next: {
      client_id: input.clientId,
      ...(secret ? { client_secret: secret } : {}),
      ...(scope ? { scope } : {}),
      ...(authorizationParams ? { authorization_params: authorizationParams } : {}),
      ...(authorizationServer ? { authorization_server: authorizationServer } : {}),
    },
    changed: true,
  };
}
