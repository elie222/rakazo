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
  /** Stdio launch arguments, which may carry tokens. */
  args?: string[];
  env?: Record<string, string>;
  /** Credential file templates by the env variable that receives the file's path. */
  files?: Record<string, string>;
  headers?: Record<string, string>;
  oauthClient?: McpOAuthClient;
  oauth?: Record<string, unknown>;
};

/** Arguments a row still holds in plaintext from before they moved into its secret. */
export function legacyMcpArgs(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

export type McpMaterialUpdate =
  | { action: "keep" }
  | { action: "store"; material: McpSecretMaterial };

/** An empty "store" material means credentials were cleared: the caller deletes the secret
 * row and nulls `secretId` instead of storing an empty object. env/headers are full-replace;
 * files are kept when omitted, and stdio arguments when none are sent for the same command.
 * OAuth state, the stored token, the stored values of the headers sent, the credentials of the
 * transport left behind and an OAuth client not yet bound to an authorization server are dropped
 * when the endpoint changed, since credentials entered for one endpoint must never be sent to
 * another server. */
export function buildMcpUpdateMaterial(
  existing: McpSecretMaterial,
  config: McpServerConfigInput,
  options: { clearOAuth?: boolean; endpointChanged?: boolean; commandChanged?: boolean } = {},
): McpMaterialUpdate {
  const input = "oauthClient" in config ? config.oauthClient : undefined;
  // On a move, a client typed again starts afresh and binds at the new endpoint's authorization
  // server. One left out stays only if it is bound to its own server: an unbound one would bind
  // to the new endpoint's server, which never issued it.
  const moved = Boolean(options.endpointChanged && existing.oauthClient);
  const client = !moved
    ? nextOAuthClient(existing.oauthClient, input)
    : input
      ? { next: nextOAuthClient(undefined, input).next, changed: true }
      : input === null || !existing.oauthClient?.authorization_server
        ? { changed: true }
        : { next: existing.oauthClient, changed: false };
  // Tokens are issued to one client, so a different client must authorize again.
  const clearOAuth = options.clearOAuth === true || client.changed;
  const material = clearOAuth ? { ...existing } : existing;
  const clearedOAuth = clearOAuth && (material.oauth !== undefined || client.changed);
  if (clearOAuth) delete material.oauth;
  if (client.changed) {
    if (client.next) material.oauthClient = client.next;
    else delete material.oauthClient;
  }
  const { files: storedFiles, args: storedArgs, ...rest } = material;
  if (options.endpointChanged) {
    delete rest.secret;
    // A transport switch moves the endpoint too; the old transport's credentials do not apply.
    if (config.transport === "stdio") delete rest.headers;
    else delete rest.env;
  }
  const args =
    config.transport !== "stdio"
      ? []
      : config.args?.length || options.commandChanged
        ? (config.args ?? [])
        : (storedArgs ?? []);
  const withArgs = args.length > 0 ? { args } : {};
  const clearing = config.clearCredential === true;
  if (clearing) {
    return {
      action: "store",
      material: {
        ...withArgs,
        ...(material.oauthClient ? { oauthClient: material.oauthClient } : {}),
        ...(material.oauth ? { oauth: material.oauth } : {}),
      },
    };
  }
  const secret = "secret" in config && config.secret ? config.secret : undefined;
  // Clients never read stored values back, so a blank one keeps what is stored under its
  // name, unless that would send it to a different endpoint.
  const keepBlank = (next: Record<string, string>, stored: Record<string, string> = {}) =>
    options.endpointChanged
      ? next
      : Object.fromEntries(
          Object.entries(next).map(([name, value]) => [name, value || (stored[name] ?? "")]),
        );
  const env = "env" in config ? keepBlank(config.env, material.env) : undefined;
  // A header sent blank to keep a value that cannot follow it to a new endpoint has none left.
  const headers =
    "headers" in config
      ? options.endpointChanged
        ? Object.fromEntries(Object.entries(config.headers).filter(([, value]) => value))
        : keepBlank(config.headers, material.headers)
      : undefined;
  const files =
    config.transport === "stdio"
      ? config.files
        ? keepBlank(config.files, storedFiles)
        : storedFiles
      : undefined;
  const hasFiles = files !== undefined && Object.keys(files).length > 0;
  const existingHasMaterial = Boolean(
    material.secret ||
      storedArgs?.length ||
      (material.env && Object.keys(material.env).length > 0) ||
      (storedFiles && Object.keys(storedFiles).length > 0) ||
      (material.headers && Object.keys(material.headers).length > 0) ||
      material.oauthClient ||
      material.oauth,
  );
  const suppliesMaterial = Boolean(
    secret ||
      args.length > 0 ||
      (env && Object.keys(env).length > 0) ||
      (headers && Object.keys(headers).length > 0) ||
      hasFiles,
  );
  if (!existingHasMaterial && !suppliesMaterial) {
    // A stored blob of only empty containers is not a credential, but its row still
    // reports one and nothing in this update can clear it. Clear it here so the caller
    // deletes the row. A material without container keys belongs to a row without a
    // stored secret, so keep stays keep and the caller writes nothing.
    if ("env" in existing || "headers" in existing || "files" in existing) {
      return { action: "store", material: {} };
    }
    // Leftover empty arguments are not a credential either.
    const { args: _emptyArgs, ...kept } = material;
    return clearedOAuth ? { action: "store", material: kept } : { action: "keep" };
  }
  const stored: McpSecretMaterial = {
    ...rest,
    ...withArgs,
    ...(secret ? { secret } : {}),
    ...(env !== undefined ? { env } : {}),
    ...(headers !== undefined ? { headers } : {}),
    ...(hasFiles ? { files } : {}),
  };
  // env and headers are full-replace and the contract defaults them to {}, so an update
  // without credentials replaces the stored names with nothing. An empty record is not a
  // credential: dropping it lets an emptied material reach {} so the caller deletes the
  // secret row instead of storing `{"env":{}}` or `{"headers":{}}` and reporting a saved
  // credential.
  if (stored.env !== undefined && Object.keys(stored.env).length === 0) delete stored.env;
  if (stored.headers !== undefined && Object.keys(stored.headers).length === 0) {
    delete stored.headers;
  }
  return { action: "store", material: stored };
}

/** Resolve the client an update asks for. A resent client ID at the same authorization server
 * keeps the stored secret, scope and authorization parameters it leaves out, since clients never
 * read them back; an empty scope or parameters clears them, and a different client ID or
 * authorization server never inherits them. Any
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
  const authorizationServer = input.authorizationServer
    ? new URL(input.authorizationServer).href
    : undefined;
  // Client IDs belong to their authorization server, so one moved to another starts afresh, and
  // one that inherits stays bound to the server it was bound to.
  const inherits =
    sameClient &&
    (authorizationServer === undefined || authorizationServer === existing?.authorization_server);
  const boundTo = authorizationServer ?? (inherits ? existing?.authorization_server : undefined);
  const secret = input.clientSecret ?? (inherits ? existing?.client_secret : undefined);
  const scope =
    input.scope === undefined ? (inherits ? existing?.scope : undefined) : input.scope || undefined;
  const authorizationParams =
    input.authorizationParams === undefined
      ? inherits
        ? existing?.authorization_params
        : undefined
      : input.authorizationParams || undefined;
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
      ...(boundTo ? { authorization_server: boundTo } : {}),
    },
    changed: true,
  };
}
