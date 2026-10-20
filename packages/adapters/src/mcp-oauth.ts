import { randomUUID } from "node:crypto";
import type {
  OAuthClientProvider,
  OAuthDiscoveryState,
} from "@modelcontextprotocol/sdk/client/auth.js";
import { refreshAuthorization } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InvalidGrantError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { SecretStore } from "@rakazo/adapter-kit";
import { SecretStoreUnavailableError } from "@rakazo/adapter-kit";
import { isLocalMcpHost } from "@rakazo/contracts";
import { readBoundedResponseBytes } from "@rakazo/core";
import type { Prisma, PrismaClient } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { sanitizeConnectorError } from "./connector-safety.js";
import { secureFetch, validateUrl, withEndpointOriginFallback } from "./mcp-transport.js";
import { actorMayUsePrivateEndpoint } from "./private-endpoint.js";
import type { RemoteTransportDependencies } from "./remote-mcp.js";
import { persistPreparedSecret } from "./secret-persistence.js";
import { deleteSecretBestEffort } from "./secret-store-factory.js";

type OAuthState = {
  tokens?: OAuthTokens;
  obtainedAt?: number;
  clientInformation?: OAuthClientInformationMixed;
  discoveryState?: OAuthDiscoveryState;
  redirectUri?: string;
  codeVerifier?: string;
};

export type OAuthMaterial = {
  secret?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
  oauth?: OAuthState;
};

/** Values that must never appear in model-visible tool results or errors. */
export function oauthMaterialSecrets(material: OAuthMaterial): string[] {
  const values: string[] = [];
  const add = (value: string | undefined) => {
    if (!value) return;
    values.push(value);
    const bearer = value.match(/^Bearer\s+(.+)$/i);
    if (bearer?.[1]) values.push(bearer[1]);
  };
  add(material.secret);
  add(material.oauth?.tokens?.access_token);
  add(material.oauth?.tokens?.refresh_token);
  const client = material.oauth?.clientInformation;
  if (client && "client_secret" in client && typeof client.client_secret === "string") {
    add(client.client_secret);
  }
  for (const [key, value] of Object.entries(material.headers ?? {})) {
    if (isAuthHeaderKey(key)) {
      // Cookie / X-Session / Authorization always carry auth material, including short values.
      add(value);
    } else if (
      isExplicitCredentialKey(key) &&
      looksLikeSecretValue(value, { allowNumeric: true })
    ) {
      add(value);
    } else if (
      isAmbiguousCredentialKey(key) &&
      looksLikeSecretValue(value, { allowNumeric: false })
    ) {
      add(value);
    }
  }
  for (const [key, value] of Object.entries(material.env ?? {})) {
    if (isExplicitCredentialKey(key) && looksLikeSecretValue(value, { allowNumeric: true })) {
      add(value);
    } else if (
      isAmbiguousCredentialKey(key) &&
      looksLikeSecretValue(value, { allowNumeric: false })
    ) {
      add(value);
    }
  }
  return [...new Set(values)];
}

/** Headers whose values are credentials even when short (e.g. Cookie, X-Session). */
function isAuthHeaderKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/-/g, "_");
  return (
    normalized === "authorization" ||
    normalized === "cookie" ||
    normalized === "set_cookie" ||
    normalized === "x_session" ||
    normalized === "x_api_key" ||
    normalized === "api_key" ||
    normalized === "x_auth_token"
  );
}

/** Explicit credential keys (access_token, api_key, …); numeric values stay redacted. */
function isExplicitCredentialKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/-/g, "_");
  if (isAuthHeaderKey(key)) return true;
  return /(?:^|_)(secret|password|credential|access_token|refresh_token|id_token|auth_token|session_token|session_id|session_key|session_secret|api_key|api_token)$/.test(
    normalized,
  );
}

/** Ambiguous *_token keys where numeric-only values are usually config, not secrets. */
function isAmbiguousCredentialKey(key: string): boolean {
  if (isExplicitCredentialKey(key)) return false;
  const normalized = key.toLowerCase().replace(/-/g, "_");
  if (/(?:^|_)token$/.test(normalized)) {
    return !/(timeout|ttl|max|count|type|mode|name)$/.test(normalized);
  }
  return false;
}

/**
 * Values under credential-shaped keys must look like secrets before entering
 * global substring redaction. Ordinary enums such as "production" or "oauth"
 * would otherwise corrupt unrelated tool output. Numeric-only filtering applies
 * only to ambiguous keys — explicit carriers still register OTP-like tokens.
 */
function looksLikeSecretValue(value: string, options: { allowNumeric?: boolean } = {}): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (COMMON_CONFIG_VALUES.has(trimmed.toLowerCase())) return false;
  if (!options.allowNumeric && /^\d+(\.\d+)?$/.test(trimmed)) return false;
  return true;
}

const COMMON_CONFIG_VALUES = new Set([
  "production",
  "development",
  "staging",
  "test",
  "testing",
  "oauth",
  "openid",
  "true",
  "false",
  "yes",
  "no",
  "on",
  "off",
  "none",
  "null",
  "debug",
  "info",
  "warn",
  "error",
  "http",
  "https",
  "local",
  "localhost",
  "enabled",
  "disabled",
  "default",
  "auto",
  "manual",
  "read",
  "write",
  "sync",
  "async",
]);

type ServerRef = { id: string; endpoint: string | null; secretId: string | null };
type ActorRef = { spaceId: string; userId: string };

export class McpReauthorizationRequiredError extends Error {
  readonly code = "MCP_REAUTHORIZATION_REQUIRED";
  constructor(readonly serverId: string) {
    super("MCP authorization expired. Reconnect this server in MCP settings.");
    this.name = "McpReauthorizationRequiredError";
  }
}

/** The grant a provider holds: tokens and when they were issued. */
type TokenGrant = Pick<OAuthState, "tokens" | "obtainedAt">;

/**
 * Writes the provider's material. `storedRefreshToken` is the refresh token
 * this provider last saw in storage; when given, the write keeps the stored
 * grant if another process has since changed it, and returns that grant.
 * Writes carrying newly issued tokens omit it and always win.
 */
type PersistMaterial = (
  material: OAuthMaterial,
  storedRefreshToken?: string | null,
) => Promise<TokenGrant | undefined>;

type ProviderOptions = {
  redirectUri?: string;
  state?: string;
  onAuthorization?: (url: URL) => void;
  onPersisted?: (record: { id: string; ref: string; material: OAuthMaterial }) => void;
  /** Renews the grant under the server's credential lock and returns the grant now stored. */
  refresh?: (heldRefreshToken: string) => Promise<TokenGrant>;
};

/** Refresh before expiry to cover clock skew and request time. */
const TOKEN_REFRESH_SKEW_MS = 60_000;

function accessTokenExpired(oauth: OAuthState | undefined): boolean {
  const lifetimeSeconds = oauth?.tokens?.expires_in;
  if (!oauth?.tokens?.refresh_token || !oauth.obtainedAt || !lifetimeSeconds) return false;
  return Date.now() >= oauth.obtainedAt + lifetimeSeconds * 1000 - TOKEN_REFRESH_SKEW_MS;
}

// RFC 8707 resource binding: only accept a self-declared canonical resource
// that is itself a well-formed HTTPS (or localhost) URL. Providers like Brex
// advertise an internal alias for their public origin, so cross-host
// resources are allowed, but malformed or cleartext resources are rejected
// and the SDK falls back to deriving the resource from the server URL.
function canonicalResource(resource: string | undefined): URL | undefined {
  if (!resource) return undefined;
  try {
    return validateUrl(resource);
  } catch {
    return undefined;
  }
}

function applyGrant(oauth: OAuthState, grant: TokenGrant): void {
  if (grant.tokens) oauth.tokens = grant.tokens;
  else delete oauth.tokens;
  if (grant.obtainedAt) oauth.obtainedAt = grant.obtainedAt;
  else delete oauth.obtainedAt;
}

/** One SDK OAuth provider backed by the same encrypted material used at runtime. */
export class StoredMcpOAuthProvider implements OAuthClientProvider {
  authorizationUrl?: URL;
  private readonly runtimeState = randomUUID();
  private persistQueue = Promise.resolve();
  private refreshing?: Promise<void>;
  /** The refresh token storage held when this provider last read or wrote it. */
  private storedRefreshToken: string | null;

  constructor(
    readonly serverId: string,
    private readonly material: OAuthMaterial,
    private readonly persistMaterial: PersistMaterial,
    private readonly options: ProviderOptions = {},
  ) {
    this.storedRefreshToken = material.oauth?.tokens?.refresh_token ?? null;
    if (options.redirectUri) {
      this.material.oauth = { ...(this.material.oauth ?? {}), redirectUri: options.redirectUri };
    }
  }

  get redirectUrl(): string | undefined {
    return this.options.redirectUri ?? this.material.oauth?.redirectUri;
  }

  get clientMetadata(): OAuthClientMetadata {
    const redirectUri = this.redirectUrl;
    if (!redirectUri) throw new McpReauthorizationRequiredError(this.serverId);
    const hostname = new URL(redirectUri).hostname;
    const applicationType = hostname === "localhost" || hostname === "127.0.0.1" ? "native" : "web";
    return {
      redirect_uris: [redirectUri],
      client_name: "Rakazo",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      application_type: applicationType,
    } as OAuthClientMetadata;
  }

  state(): string {
    return this.options.state ?? this.runtimeState;
  }
  clientInformation(): OAuthClientInformationMixed | undefined {
    return this.material.oauth?.clientInformation;
  }
  async saveClientInformation(value: OAuthClientInformationMixed): Promise<void> {
    this.oauth().clientInformation = value;
    await this.persist();
  }
  /**
   * Some providers return a JSON-RPC error with HTTP 200 after access-token
   * expiry, so the SDK's 401-driven refresh does not run. Renew from the stored
   * expiry before returning a token that has lapsed.
   */
  async tokens(): Promise<OAuthTokens | undefined> {
    if (this.options.refresh && accessTokenExpired(this.material.oauth)) {
      this.refreshing ??= this.refreshExpiredToken().finally(() => {
        this.refreshing = undefined;
      });
      await this.refreshing;
    }
    return this.material.oauth?.tokens;
  }

  private async refreshExpiredToken(): Promise<void> {
    const oauth = this.material.oauth;
    const held = oauth?.tokens;
    if (!oauth || !held?.refresh_token || !this.options.refresh) return;
    try {
      const grant = await this.options.refresh(held.refresh_token);
      // A write that landed while the refresh ran is newer than the grant it replaced.
      if (this.material.oauth !== oauth || oauth.tokens !== held) return;
      applyGrant(oauth, grant);
      this.storedRefreshToken = grant.tokens?.refresh_token ?? null;
    } catch {
      // Transient setup or transport failures must not discard a usable token.
    }
  }

  async saveTokens(value: OAuthTokens): Promise<void> {
    const oauth = this.oauth();
    oauth.tokens = value;
    oauth.obtainedAt = Date.now();
    await this.persist(true);
  }
  async redirectToAuthorization(url: URL): Promise<void> {
    let authorizationUrl: URL;
    try {
      authorizationUrl = validateUrl(url, { allowHttpLocalhost: true });
    } catch (error) {
      if (!this.options.onAuthorization) {
        await this.invalidateCredentials("tokens");
      }
      throw error;
    }
    this.authorizationUrl = authorizationUrl;
    if (this.options.onAuthorization) {
      this.options.onAuthorization(authorizationUrl);
      return;
    }
    // Runtime re-auth needs the user; drop the dead tokens so status reads "reconnect".
    await this.invalidateCredentials("tokens");
    throw new McpReauthorizationRequiredError(this.serverId);
  }
  async saveCodeVerifier(value: string): Promise<void> {
    this.oauth().codeVerifier = value;
    await this.persist();
  }
  codeVerifier(): string {
    const verifier = this.material.oauth?.codeVerifier;
    if (!verifier) throw new Error("OAuth PKCE verifier is missing");
    return verifier;
  }
  async validateResourceURL(_serverUrl: string | URL, resource?: string): Promise<URL | undefined> {
    return canonicalResource(resource);
  }
  async saveDiscoveryState(value: OAuthDiscoveryState): Promise<void> {
    this.oauth().discoveryState = value;
    await this.persist();
  }
  discoveryState(): OAuthDiscoveryState | undefined {
    return this.material.oauth?.discoveryState;
  }
  async invalidateCredentials(
    scope: "all" | "client" | "tokens" | "verifier" | "discovery",
  ): Promise<void> {
    if (scope === "all") {
      const redirectUri = this.redirectUrl;
      this.material.oauth = redirectUri ? { redirectUri } : undefined;
    } else if (this.material.oauth) {
      if (scope === "client") delete this.material.oauth.clientInformation;
      if (scope === "tokens") {
        delete this.material.oauth.tokens;
        delete this.material.oauth.obtainedAt;
      }
      if (scope === "verifier") delete this.material.oauth.codeVerifier;
      if (scope === "discovery") delete this.material.oauth.discoveryState;
    }
    await this.persist();
  }

  private oauth(): OAuthState {
    if (!this.material.oauth) this.material.oauth = {};
    return this.material.oauth;
  }

  /** `issued` marks a write carrying tokens the server just issued, which replace any stored grant. */
  private async persist(issued = false): Promise<void> {
    const snapshot = structuredClone(this.material);
    const held = this.material.oauth?.tokens;
    const storedRefreshToken = issued ? undefined : this.storedRefreshToken;
    const next = this.persistQueue.then(async () => {
      const kept = await this.persistMaterial(snapshot, storedRefreshToken);
      const oauth = this.material.oauth;
      if (kept && oauth && oauth.tokens === held) applyGrant(oauth, kept);
      this.storedRefreshToken = (kept ?? snapshot.oauth)?.tokens?.refresh_token ?? null;
    });
    this.persistQueue = next.catch(() => undefined);
    await next;
  }
}

type Pending = {
  serverId: string;
  spaceId: string;
  userId: string;
  endpoint: string;
  provider: StoredMcpOAuthProvider;
  createdAt: number;
  expiry?: ReturnType<typeof setTimeout>;
};

const PENDING_TTL_MS = 10 * 60_000;
const MAX_PENDING_SESSIONS = 100;

/** OAuth traffic runs through the same URL policy as runtime MCP requests
 * (HTTPS enforced, redirects rejected), with the endpoint-origin fallback
 * layered on top for providers like Brex. */
function oauthFetch(
  endpoint: string,
  network: RemoteTransportDependencies,
  material: OAuthMaterial = {},
  allowPrivateEndpoint = false,
): {
  fetch: typeof fetch;
  close: () => Promise<void>;
  headers: Record<string, string>;
  publicError: (error: unknown, message: string) => Error;
} {
  const url = new URL(endpoint);
  const localHttp = url.protocol === "http:" && isLocalMcpHost(url.hostname);
  const headers = {
    ...material.headers,
    ...(material.secret
      ? {
          Authorization: material.secret.startsWith("Bearer ")
            ? material.secret
            : `Bearer ${material.secret}`,
        }
      : {}),
  };
  const safeFetch = secureFetch(
    url,
    {
      allowHttpLocalhost: localHttp,
      allowLocalHttpCredentials: localHttp,
      allowPrivateEndpoint,
    },
    { headers },
    network,
  );
  const fallbackFetch = withEndpointOriginFallback(url.origin, safeFetch);
  // Errors raised by this network layer (URL policy, redirects, unreachable
  // hosts) carry only our own text. Anything else was built by the SDK from an
  // upstream response and may quote its body, so the caller gets `message`.
  // A structured OAuth error is the protocol's own failure: keep its status,
  // error code, and description instead of hiding them behind `message`.
  const networkErrors = new WeakSet<Error>();
  let rejection: OAuthRejection | undefined;
  const recordingFetch: typeof fetch = async (input, init) => {
    try {
      const response = await fallbackFetch(input, init);
      if (!response.ok) {
        const next = await readOAuthRejection(response);
        if (next) rejection = next;
      }
      return response;
    } catch (error) {
      if (error instanceof Error) networkErrors.add(error);
      throw error;
    }
  };
  return {
    headers,
    fetch: recordingFetch,
    close: () => safeFetch.close(),
    publicError: (error, message) => {
      if (error instanceof Error && networkErrors.has(error)) return error;
      const secrets = oauthMaterialSecrets(material);
      const sdk = sanitizeConnectorError(error, secrets);
      const surfaced = rejection ? formatOAuthRejection(rejection, sdk, secrets) : undefined;
      getLogger().warn(`${message}: ${surfaced ?? sdk}`);
      return new Error(surfaced ? `${message}: ${surfaced}` : message);
    },
  };
}

type OAuthRejection = { status: number; code: string; description: string };

const OAUTH_ERROR_BODY_MAX_CHARS = 8_000;
// A JavaScript character is at most 3 UTF-8 bytes, so a longer body cannot pass the character cap.
const OAUTH_ERROR_BODY_MAX_BYTES = OAUTH_ERROR_BODY_MAX_CHARS * 3;

/** Read an RFC 6749 error object without consuming the body the SDK still needs. */
async function readOAuthRejection(response: Response): Promise<OAuthRejection | undefined> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > OAUTH_ERROR_BODY_MAX_BYTES) {
    return undefined;
  }
  let text: string;
  try {
    const bytes = await readBoundedResponseBytes(response.clone(), {
      maxBytes: OAUTH_ERROR_BODY_MAX_BYTES,
      tooLargeMessage: "OAuth error response is too large",
      read: (operation) => operation(),
    });
    text = new TextDecoder().decode(bytes);
  } catch {
    return undefined;
  }
  if (text.length > OAUTH_ERROR_BODY_MAX_CHARS) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  const code = record.error;
  if (typeof code !== "string" || !/^[\w.-]{1,64}$/.test(code)) return undefined;
  const description = typeof record.error_description === "string" ? record.error_description : "";
  return { status: response.status, code, description };
}

/** Surface a rejection only when it is the error the SDK just threw.
 *
 * Earlier challenges (a 401 while discovery continues) must not replace a
 * later, different failure. The SDK message is already redacted and
 * length-limited, so the description is cleaned the same way before comparing.
 * Unstructured bodies stay out of the caller-facing message; the log still
 * receives the SDK text. */
function formatOAuthRejection(
  rejection: OAuthRejection,
  sdk: string,
  secrets: string[],
): string | undefined {
  if (sdk.includes("Raw body:")) return undefined;
  // Redact the whole description first. A later cut can land inside a secret, and
  // the redactor only matches the complete value.
  const cleaned = sanitizeConnectorError(rejection.description, secrets);
  if (cleaned.trim() !== sdk.trim()) return undefined;
  const description = cleaned.replace(/\s+/g, " ").trim().slice(0, 300);
  const detail = description ? `${rejection.code}: ${description}` : rejection.code;
  return sanitizeConnectorError(`HTTP ${rejection.status} ${detail}`, secrets);
}

type MaterialSnapshot = {
  server: { endpoint: string | null; secretId: string | null };
  secret: { id: string; ciphertext: string } | null;
};

/**
 * A refresh holds the credential lock across one token request and the write.
 * The lock wait runs inside the transaction, so it gets its own cap. Whatever
 * is left after the wait and the request goes to the secret write: a rotated
 * token that never commits is lost.
 */
const REFRESH_LOCK_WAIT_MS = 10_000;
const REFRESH_REQUEST_TIMEOUT_MS = 15_000;
const REFRESH_TRANSACTION_MS = 60_000;

function lockMaterial(tx: Prisma.TransactionClient, serverId: string): Promise<number> {
  return tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('mcp-oauth-material'), hashtext(${serverId}))`;
}

/** One refresh-token grant against the stored authorization server. */
async function requestRefresh(
  oauth: OAuthState,
  refreshToken: string,
  fetchFn: typeof fetch,
): Promise<OAuthTokens> {
  const discovery = oauth.discoveryState;
  if (!discovery?.authorizationServerUrl || !oauth.clientInformation)
    throw new Error("MCP OAuth state cannot refresh");
  return refreshAuthorization(discovery.authorizationServerUrl, {
    metadata: discovery.authorizationServerMetadata,
    clientInformation: oauth.clientInformation,
    refreshToken,
    resource: canonicalResource(discovery.resourceMetadata?.resource),
    fetchFn: (input, init) =>
      fetchFn(input, { ...init, signal: AbortSignal.timeout(REFRESH_REQUEST_TIMEOUT_MS) }),
  });
}

export class McpOAuthBroker {
  private readonly pending = new Map<string, Pending>();

  constructor(
    private readonly prisma: PrismaClient,
    private readonly secrets: SecretStore,
    private readonly network: RemoteTransportDependencies = {},
    private readonly allowPrivateEndpoint = false,
  ) {}

  async statusFor(
    server: ServerRef,
    context: ActorRef,
  ): Promise<"none" | "connected" | "reconnect"> {
    const { material } = await this.loadMaterial(server, context);
    if (material.oauth?.tokens) return "connected";
    return material.oauth ? "reconnect" : "none";
  }

  async statusForCiphertext(
    ciphertext: string | undefined,
    recordId: string | undefined,
  ): Promise<"none" | "connected" | "reconnect"> {
    const material = ciphertext && recordId ? await this.read(ciphertext, recordId) : {};
    if (material.oauth?.tokens) return "connected";
    return material.oauth ? "reconnect" : "none";
  }

  async providerFor(
    server: ServerRef,
    context: ActorRef,
    loaded?: { material: OAuthMaterial; secretId?: string },
    onPersisted?: ProviderOptions["onPersisted"],
  ): Promise<OAuthClientProvider | undefined> {
    const material = loaded ?? (await this.loadMaterial(server, context));
    if (!material.material.oauth) return undefined;
    return this.createProvider(server, context, material, { onPersisted });
  }

  async begin(input: {
    serverId: string;
    spaceId: string;
    userId: string;
    redirectUri: string;
  }): Promise<
    | { status: "authorization_required"; sessionId: string; authorizationUrl: string }
    | { status: "already_connected" | "authorization_not_requested" }
  > {
    const server = await this.prisma.mcpServer.findFirst({
      where: {
        id: input.serverId,
        spaceId: input.spaceId,
        userId: input.userId,
        enabled: true,
      },
    });
    if (!server?.endpoint) throw new Error("MCP server endpoint is required for OAuth");
    await this.sweepExpiredPending();
    let actorPending = 0;
    for (const pending of this.pending.values()) {
      if (pending.spaceId === input.spaceId && pending.userId === input.userId) {
        actorPending += 1;
      }
    }
    if (actorPending >= MAX_PENDING_SESSIONS) {
      throw new Error("Too many pending MCP authorization attempts; wait and try again");
    }
    const activeCount = await this.prisma.mcpOAuthSession.count({
      where: { spaceId: input.spaceId, userId: input.userId },
    });
    if (activeCount >= MAX_PENDING_SESSIONS) {
      throw new Error("Too many pending MCP authorization attempts; wait and try again");
    }
    const sessionId = randomUUID();
    const context = { spaceId: input.spaceId, userId: input.userId };
    const loaded = await this.loadMaterial(server, context);
    let authorizationUrl: URL | undefined;
    const provider = this.createProvider(server, context, loaded, {
      redirectUri: input.redirectUri,
      state: sessionId,
      onAuthorization: (url) => {
        authorizationUrl = url;
      },
    });
    // Never destroy working tokens here: if this attempt fails (network error,
    // cancelled popup), the server keeps its valid connection. The SDK itself
    // invalidates dead tokens when a refresh is rejected with invalid_grant.
    const endpoint = new URL(server.endpoint);
    const networkFetch = oauthFetch(
      server.endpoint,
      this.network,
      loaded.material,
      await actorMayUsePrivateEndpoint(this.prisma, input.userId, this.allowPrivateEndpoint),
    );
    const transport = new StreamableHTTPClientTransport(endpoint, {
      requestInit: { headers: networkFetch.headers },
      authProvider: provider,
      fetch: networkFetch.fetch,
    });
    const client = new Client({ name: "rakazo-oauth", version: "0.1.0" });
    const signal = AbortSignal.timeout(15_000);
    try {
      await client.connect(transport, { signal, timeout: 15_000 });
    } catch (error) {
      if (!authorizationUrl) throw networkFetch.publicError(error, "Could not start MCP OAuth");
    } finally {
      await client.close().catch(() => undefined);
      await networkFetch.close().catch(() => undefined);
    }
    if (!authorizationUrl) {
      if (await provider.tokens()) {
        return { status: "already_connected" };
      }
      return { status: "authorization_not_requested" };
    }
    const sessionMaterial = await this.secrets.put(
      JSON.stringify(loaded.material),
      {
        operationId: "mcp.oauth.session",
        traceId: "mcp.oauth.session",
        spaceId: input.spaceId,
        userId: input.userId,
        botId: "mcp",
        signal: new AbortController().signal,
      },
      { recordId: sessionId, ephemeral: true },
    );
    await this.prisma.mcpOAuthSession.create({
      data: {
        id: sessionId,
        serverId: server.id,
        spaceId: input.spaceId,
        userId: input.userId,
        endpoint: server.endpoint,
        redirectUri: input.redirectUri,
        oauthCiphertext: sessionMaterial.ciphertext,
      },
    });
    const expiry = setTimeout(() => {
      this.pending.delete(sessionId);
      void this.prisma.mcpOAuthSession
        .deleteMany({ where: { id: sessionId } })
        .catch(() => undefined);
    }, PENDING_TTL_MS);
    expiry.unref?.();
    this.pending.set(sessionId, {
      serverId: server.id,
      spaceId: input.spaceId,
      userId: input.userId,
      endpoint: server.endpoint,
      provider,
      createdAt: Date.now(),
      expiry,
    });
    return {
      status: "authorization_required",
      sessionId,
      authorizationUrl: authorizationUrl.toString(),
    };
  }

  async complete(input: {
    sessionId: string;
    code: string;
    state: string;
    spaceId: string;
    userId: string;
  }): Promise<void> {
    await this.sweepExpiredPending();
    if (input.state !== input.sessionId) {
      throw new Error("MCP OAuth session is invalid or expired");
    }
    let pending = this.pending.get(input.sessionId);
    if (pending && (pending.spaceId !== input.spaceId || pending.userId !== input.userId)) {
      pending = undefined;
    }
    if (!pending) {
      const session = await this.prisma.mcpOAuthSession.findFirst({
        where: {
          id: input.sessionId,
          spaceId: input.spaceId,
          userId: input.userId,
          createdAt: { gte: new Date(Date.now() - PENDING_TTL_MS) },
        },
      });
      if (!session) throw new Error("MCP OAuth session is invalid or expired");
      const server = await this.prisma.mcpServer.findFirst({
        where: {
          id: session.serverId,
          spaceId: input.spaceId,
          userId: input.userId,
          enabled: true,
        },
      });
      if (!server?.endpoint) throw new Error("MCP OAuth session is invalid or expired");
      const context = { spaceId: input.spaceId, userId: input.userId };
      const loaded = {
        material: await this.read(session.oauthCiphertext, session.id),
        ...(server.secretId ? { secretId: server.secretId } : {}),
      };
      pending = {
        serverId: server.id,
        spaceId: input.spaceId,
        userId: input.userId,
        endpoint: session.endpoint,
        provider: this.createProvider(server, context, loaded, {
          redirectUri: session.redirectUri,
          state: session.id,
        }),
        createdAt: session.createdAt.getTime(),
        expiry: undefined,
      };
    }
    // Consume the session up front so a failed token exchange cannot be
    // retried with a replayed code; the user starts a fresh flow instead.
    this.pending.delete(input.sessionId);
    if (pending.expiry) clearTimeout(pending.expiry);
    const consumed = await this.prisma.mcpOAuthSession.deleteMany({
      where: {
        id: input.sessionId,
        spaceId: input.spaceId,
        userId: input.userId,
      },
    });
    if (consumed.count !== 1) throw new Error("MCP OAuth session is invalid or expired");
    const endpoint = new URL(pending.endpoint);
    const networkFetch = oauthFetch(
      pending.endpoint,
      this.network,
      {},
      await actorMayUsePrivateEndpoint(this.prisma, pending.userId, this.allowPrivateEndpoint),
    );
    const transport = new StreamableHTTPClientTransport(endpoint, {
      authProvider: pending.provider,
      fetch: networkFetch.fetch,
    });
    try {
      await transport.finishAuth(input.code);
    } catch (error) {
      throw networkFetch.publicError(error, "Could not complete MCP OAuth");
    } finally {
      await transport.close().catch(() => undefined);
      await networkFetch.close().catch(() => undefined);
    }
    if (!(await pending.provider.tokens())) throw new Error("MCP OAuth authorization failed");
    // Bump the revision so cached runtime sessions rebuild with the fresh tokens.
    await this.prisma.mcpServer.update({
      where: { id: pending.serverId },
      data: { revision: { increment: 1 } },
    });
  }

  private async sweepExpiredPending(): Promise<void> {
    const cutoff = Date.now() - PENDING_TTL_MS;
    for (const [sessionId, pending] of this.pending) {
      if (pending.createdAt < cutoff) {
        this.discardPending(sessionId, pending);
      }
    }
    await this.prisma.mcpOAuthSession.deleteMany({
      where: { createdAt: { lt: new Date(cutoff) } },
    });
  }

  private discardPending(sessionId: string, pending: Pending): void {
    if (pending.expiry) clearTimeout(pending.expiry);
    this.pending.delete(sessionId);
  }

  async disconnect(input: { serverId: string; spaceId: string; userId: string }): Promise<void> {
    const server = await this.prisma.mcpServer.findFirst({
      where: { id: input.serverId, spaceId: input.spaceId, userId: input.userId },
    });
    if (!server?.secretId) return;
    const row = await this.prisma.secret.findFirst({
      where: { id: server.secretId, spaceId: input.spaceId, userId: input.userId },
    });
    if (!row) return;
    const material = await this.read(row.ciphertext, row.id);
    delete material.oauth;
    await this.replaceMaterial(server.id, material, input, { incrementRevision: true });
  }

  private async loadMaterial(
    server: ServerRef,
    context: ActorRef,
  ): Promise<{ material: OAuthMaterial; secretId?: string }> {
    if (!server.secretId) return { material: {} };
    const row = await this.prisma.secret.findFirst({
      where: { id: server.secretId, spaceId: context.spaceId, userId: context.userId },
    });
    return row
      ? { material: await this.read(row.ciphertext, row.id), secretId: row.id }
      : { material: {} };
  }

  private createProvider(
    server: ServerRef,
    context: ActorRef,
    loaded: { material: OAuthMaterial; secretId?: string },
    options: ProviderOptions = {},
  ): StoredMcpOAuthProvider {
    const endpoint = server.endpoint;
    return new StoredMcpOAuthProvider(
      server.id,
      loaded.material,
      (material, storedRefreshToken) =>
        this.replaceMaterial(server.id, material, context, {
          expectedEndpoint: endpoint,
          onPersisted: options.onPersisted,
          storedRefreshToken,
        }),
      {
        ...(endpoint
          ? {
              refresh: (held: string) =>
                this.refreshGrant(server.id, endpoint, context, held, options.onPersisted),
            }
          : {}),
        ...options,
      },
    );
  }

  /**
   * Authorization servers rotate refresh tokens for public clients, so a
   * refresh token works once. The API and worker each hold their own copy of
   * the grant: the refresh runs under the server's credential lock against the
   * stored grant, and a process whose copy is stale adopts the stored one
   * instead of spending a token another process already rotated.
   */
  private async refreshGrant(
    serverId: string,
    endpoint: string,
    context: ActorRef,
    held: string,
    onPersisted?: ProviderOptions["onPersisted"],
  ): Promise<TokenGrant> {
    // Resolve the network before taking a connection for the lock.
    const network = oauthFetch(
      endpoint,
      this.network,
      {},
      await actorMayUsePrivateEndpoint(this.prisma, context.userId, this.allowPrivateEndpoint),
    );
    let stored: { id: string; ciphertext: string } | undefined;
    try {
      const result = await persistPreparedSecret(
        this.prisma,
        this.secrets,
        undefined,
        () =>
          this.prisma.$transaction(
            async (tx) => {
              await tx.$executeRaw`SELECT set_config('lock_timeout', ${`${REFRESH_LOCK_WAIT_MS}ms`}, true)`;
              await lockMaterial(tx, serverId);
              const snapshot = await this.snapshot(tx, serverId, context, endpoint);
              const material = snapshot.secret
                ? await this.read(snapshot.secret.ciphertext, snapshot.secret.id)
                : {};
              const oauth = material.oauth;
              const current = oauth?.tokens?.refresh_token;
              if (!oauth || !current || (current !== held && !accessTokenExpired(oauth)))
                return { grant: { tokens: oauth?.tokens, obtainedAt: oauth?.obtainedAt } };
              let grant: TokenGrant;
              try {
                grant = { tokens: await requestRefresh(oauth, current, network.fetch) };
                grant.obtainedAt = Date.now();
              } catch (error) {
                // Under the lock `current` is the stored token, so a rejection
                // means the grant is revoked, not rotated by another process.
                if (!(error instanceof InvalidGrantError)) throw error;
                grant = {};
              }
              applyGrant(oauth, grant);
              stored = await this.putMaterial(material, context);
              if (!(await this.commitMaterial(tx, serverId, context, snapshot, stored)))
                throw new Error("MCP credentials changed during refresh; retry");
              return { grant, record: { id: stored.id, ref: stored.ciphertext, material } };
            },
            { maxWait: REFRESH_LOCK_WAIT_MS, timeout: REFRESH_TRANSACTION_MS },
          ),
        (result) => {
          if (result.record) onPersisted?.(result.record);
        },
      );
      return result.grant;
    } catch (error) {
      if (stored) await deleteSecretBestEffort(this.secrets, stored.ciphertext, stored.id);
      throw error;
    } finally {
      await network.close().catch(() => undefined);
    }
  }

  private async replaceMaterial(
    serverId: string,
    material: OAuthMaterial,
    context: ActorRef,
    options: {
      incrementRevision?: boolean;
      expectedEndpoint?: string | null;
      onPersisted?: ProviderOptions["onPersisted"];
      storedRefreshToken?: string | null;
    } = {},
  ): Promise<TokenGrant | undefined> {
    // Take a DB-only snapshot, then do provider I/O with no transaction open.
    // Recheck both the pointer and ciphertext under the existing advisory lock.
    for (let attempt = 0; attempt < 5; attempt++) {
      const snapshot = await this.prisma.$transaction((tx) =>
        this.snapshot(tx, serverId, context, options.expectedEndpoint),
      );
      const nextMaterial = snapshot.secret
        ? await this.read(snapshot.secret.ciphertext, snapshot.secret.id)
        : {};
      const storedOAuth = nextMaterial.oauth;
      let kept: TokenGrant | undefined;
      if (material.oauth) {
        nextMaterial.oauth = structuredClone(material.oauth);
        if (
          options.storedRefreshToken !== undefined &&
          (storedOAuth?.tokens?.refresh_token ?? null) !== options.storedRefreshToken
        ) {
          // Another process rotated or replaced the grant; never overwrite it with an older one.
          kept = { tokens: storedOAuth?.tokens, obtainedAt: storedOAuth?.obtainedAt };
          applyGrant(nextMaterial.oauth, kept);
        }
      } else delete nextMaterial.oauth;
      const hasMaterial = Boolean(
        nextMaterial.secret ||
          Object.keys(nextMaterial.env ?? {}).length ||
          Object.keys(nextMaterial.headers ?? {}).length ||
          nextMaterial.oauth,
      );
      const stored = hasMaterial ? await this.putMaterial(nextMaterial, context) : undefined;
      const committed = await persistPreparedSecret(
        this.prisma,
        this.secrets,
        stored,
        () =>
          this.prisma.$transaction(async (tx) => {
            await lockMaterial(tx, serverId);
            return this.commitMaterial(
              tx,
              serverId,
              context,
              snapshot,
              stored,
              options.incrementRevision,
            );
          }),
        (committed) => {
          if (committed && stored)
            options.onPersisted?.({
              id: stored.id,
              ref: stored.ciphertext,
              material: nextMaterial,
            });
        },
      );
      if (committed) return kept;
    }
    throw new Error("MCP credentials changed during authorization; retry");
  }

  private async snapshot(
    tx: Prisma.TransactionClient,
    serverId: string,
    context: ActorRef,
    expectedEndpoint?: string | null,
  ): Promise<MaterialSnapshot> {
    const server = await tx.mcpServer.findFirst({
      where: { id: serverId, spaceId: context.spaceId, userId: context.userId },
      select: { endpoint: true, secretId: true },
    });
    if (!server) throw new Error("MCP server is unavailable");
    if (expectedEndpoint !== undefined && server.endpoint !== expectedEndpoint)
      throw new Error("MCP server endpoint changed during authorization; reconnect this server");
    const secret = server.secretId
      ? await tx.secret.findFirst({
          where: { id: server.secretId, spaceId: context.spaceId, userId: context.userId },
        })
      : null;
    return { server, secret };
  }

  private putMaterial(
    material: OAuthMaterial,
    context: ActorRef,
  ): Promise<{ id: string; ciphertext: string }> {
    return this.secrets.put(JSON.stringify(material), {
      operationId: "mcp.oauth.persist",
      traceId: "mcp.oauth.persist",
      spaceId: context.spaceId,
      userId: context.userId,
      botId: "mcp",
      signal: new AbortController().signal,
    });
  }

  /** Swap in `stored` if the snapshot is still current. The caller holds the credential lock. */
  private async commitMaterial(
    tx: Prisma.TransactionClient,
    serverId: string,
    context: ActorRef,
    snapshot: MaterialSnapshot,
    stored: { id: string; ciphertext: string } | undefined,
    incrementRevision = false,
  ): Promise<boolean> {
    const server = await tx.mcpServer.findFirst({
      where: { id: serverId, spaceId: context.spaceId, userId: context.userId },
      select: { endpoint: true, secretId: true },
    });
    if (!server) throw new Error("MCP server is unavailable");
    if (
      server.endpoint !== snapshot.server.endpoint ||
      server.secretId !== snapshot.server.secretId
    )
      return false;
    if (server.secretId)
      await tx.$queryRaw`SELECT id FROM secrets WHERE id = ${server.secretId} FOR UPDATE`;
    const current = server.secretId
      ? await tx.secret.findFirst({
          where: { id: server.secretId, spaceId: context.spaceId, userId: context.userId },
        })
      : null;
    if (current?.ciphertext !== snapshot.secret?.ciphertext) return false;
    if (stored)
      await tx.secret.create({
        data: {
          id: stored.id,
          spaceId: context.spaceId,
          userId: context.userId,
          kind: "mcp",
          ciphertext: stored.ciphertext,
        },
      });
    await tx.mcpServer.update({
      where: { id: serverId },
      data: {
        secretId: stored?.id ?? null,
        ...(incrementRevision ? { revision: { increment: 1 } } : {}),
      },
    });
    if (server.secretId && server.secretId !== stored?.id)
      await tx.secret.deleteMany({ where: { id: server.secretId } });
    return true;
  }

  private async read(ciphertext: string, recordId: string): Promise<OAuthMaterial> {
    try {
      const value = JSON.parse(await this.secrets.load(ciphertext, recordId));
      return value && typeof value === "object" ? (value as OAuthMaterial) : {};
    } catch (error) {
      if (error instanceof SecretStoreUnavailableError) throw error;
      return {};
    }
  }
}
