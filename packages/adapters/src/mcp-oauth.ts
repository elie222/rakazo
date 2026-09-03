import { randomUUID } from "node:crypto";
import type {
  OAuthClientProvider,
  OAuthDiscoveryState,
} from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { PrismaClient } from "@rakazo/db";
import { secureFetch, validateUrl, withEndpointOriginFallback } from "./mcp-transport.js";
import type { RemoteTransportDependencies } from "./remote-mcp.js";
import type { EncryptedSecretStore } from "./secrets.js";

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

type ServerRef = { id: string; endpoint: string | null; secretId: string | null };
type ActorRef = { spaceId: string; userId: string };

export class McpReauthorizationRequiredError extends Error {
  readonly code = "MCP_REAUTHORIZATION_REQUIRED";
  constructor(readonly serverId: string) {
    super("MCP authorization expired. Reconnect this server in MCP settings.");
    this.name = "McpReauthorizationRequiredError";
  }
}

type ProviderOptions = {
  redirectUri?: string;
  state?: string;
  onAuthorization?: (url: URL) => void;
};

/** One SDK OAuth provider backed by the same encrypted material used at runtime. */
export class StoredMcpOAuthProvider implements OAuthClientProvider {
  authorizationUrl?: URL;
  private readonly runtimeState = randomUUID();
  private persistQueue = Promise.resolve();

  constructor(
    readonly serverId: string,
    private readonly material: OAuthMaterial,
    private readonly persistMaterial: (material: OAuthMaterial) => Promise<void>,
    private readonly options: ProviderOptions = {},
  ) {
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
  tokens(): OAuthTokens | undefined {
    return this.material.oauth?.tokens;
  }
  async saveTokens(value: OAuthTokens): Promise<void> {
    const oauth = this.oauth();
    oauth.tokens = value;
    oauth.obtainedAt = Date.now();
    await this.persist();
  }
  async redirectToAuthorization(url: URL): Promise<void> {
    this.authorizationUrl = url;
    if (this.options.onAuthorization) {
      this.options.onAuthorization(url);
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
  // RFC 8707 resource binding: only accept a self-declared canonical resource
  // that is itself a well-formed HTTPS (or localhost) URL. Providers like Brex
  // advertise an internal alias for their public origin, so cross-host
  // resources are allowed, but malformed or cleartext resources are rejected
  // and the SDK falls back to deriving the resource from the server URL.
  async validateResourceURL(_serverUrl: string | URL, resource?: string): Promise<URL | undefined> {
    if (!resource) return undefined;
    try {
      return validateUrl(resource);
    } catch {
      return undefined;
    }
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

  private async persist(): Promise<void> {
    const snapshot = structuredClone(this.material);
    const next = this.persistQueue.then(() => this.persistMaterial(snapshot));
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
): { fetch: typeof fetch; close: () => Promise<void> } {
  const url = new URL(endpoint);
  const safeFetch = secureFetch(url, {}, {}, network);
  return {
    fetch: withEndpointOriginFallback(url.origin, safeFetch),
    close: () => safeFetch.close(),
  };
}

export class McpOAuthBroker {
  private readonly pending = new Map<string, Pending>();

  constructor(
    private readonly prisma: PrismaClient,
    private readonly secrets: EncryptedSecretStore,
    private readonly network: RemoteTransportDependencies = {},
  ) {}

  async statusFor(
    server: ServerRef,
    context: ActorRef,
  ): Promise<"none" | "connected" | "reconnect"> {
    const { material } = await this.loadMaterial(server, context);
    if (material.oauth?.tokens) return "connected";
    return material.oauth ? "reconnect" : "none";
  }

  statusForCiphertext(
    ciphertext: string | undefined,
    recordId: string | undefined,
  ): "none" | "connected" | "reconnect" {
    const material = ciphertext && recordId ? this.read(ciphertext, recordId) : {};
    if (material.oauth?.tokens) return "connected";
    return material.oauth ? "reconnect" : "none";
  }

  async providerFor(
    server: ServerRef,
    context: ActorRef,
    loaded?: { material: OAuthMaterial; secretId?: string },
  ): Promise<OAuthClientProvider | undefined> {
    const material = loaded ?? (await this.loadMaterial(server, context));
    if (!material.material.oauth) return undefined;
    return this.createProvider(server, context, material);
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
    const networkFetch = oauthFetch(server.endpoint, this.network);
    const transport = new StreamableHTTPClientTransport(endpoint, {
      authProvider: provider,
      fetch: networkFetch.fetch,
    });
    const client = new Client({ name: "rakazo-oauth", version: "0.1.0" });
    const signal = AbortSignal.timeout(15_000);
    try {
      await client.connect(transport, { signal, timeout: 15_000 });
    } catch (error) {
      if (!authorizationUrl) throw error;
    } finally {
      await client.close().catch(() => undefined);
      await networkFetch.close().catch(() => undefined);
    }
    if (!authorizationUrl) {
      if (provider.tokens()) {
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
      sessionId,
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
        material: this.read(session.oauthCiphertext, session.id),
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
    const networkFetch = oauthFetch(pending.endpoint, this.network);
    const transport = new StreamableHTTPClientTransport(endpoint, {
      authProvider: pending.provider,
      fetch: networkFetch.fetch,
    });
    try {
      await transport.finishAuth(input.code);
    } finally {
      await transport.close().catch(() => undefined);
      await networkFetch.close().catch(() => undefined);
    }
    if (!pending.provider.tokens()) throw new Error("MCP OAuth authorization failed");
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
    const material = this.read(row.ciphertext, row.id);
    delete material.oauth;
    await this.replaceMaterial(server.id, material, input, true);
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
      ? { material: this.read(row.ciphertext, row.id), secretId: row.id }
      : { material: {} };
  }

  private createProvider(
    server: ServerRef,
    context: ActorRef,
    loaded: { material: OAuthMaterial; secretId?: string },
    options: ProviderOptions = {},
  ): StoredMcpOAuthProvider {
    return new StoredMcpOAuthProvider(
      server.id,
      loaded.material,
      async (material) => {
        await this.replaceMaterial(server.id, material, context, false, server.endpoint);
      },
      options,
    );
  }

  private async replaceMaterial(
    serverId: string,
    material: OAuthMaterial,
    context: ActorRef,
    incrementRevision: boolean,
    expectedEndpoint?: string | null,
  ): Promise<string | undefined> {
    return this.prisma.$transaction(async (tx) => {
      // Serialize every credential rotation across API instances. OAuth
      // providers hold a session snapshot, so merge only their OAuth state
      // into the latest static material after acquiring the lock.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('mcp-oauth-material'), hashtext(${serverId}))`;
      const server = await tx.mcpServer.findFirst({
        where: {
          id: serverId,
          spaceId: context.spaceId,
          userId: context.userId,
        },
        select: { endpoint: true, secretId: true },
      });
      if (!server) throw new Error("MCP server is unavailable");
      if (expectedEndpoint !== undefined && server.endpoint !== expectedEndpoint) {
        throw new Error("MCP server endpoint changed during authorization; reconnect this server");
      }
      const currentSecret = server.secretId
        ? await tx.secret.findFirst({
            where: {
              id: server.secretId,
              spaceId: context.spaceId,
              userId: context.userId,
            },
          })
        : null;
      const nextMaterial = currentSecret
        ? this.read(currentSecret.ciphertext, currentSecret.id)
        : {};
      if (material.oauth) nextMaterial.oauth = structuredClone(material.oauth);
      else delete nextMaterial.oauth;
      const hasMaterial = Boolean(
        nextMaterial.secret ||
          Object.keys(nextMaterial.env ?? {}).length ||
          Object.keys(nextMaterial.headers ?? {}).length ||
          nextMaterial.oauth,
      );
      const stored = hasMaterial
        ? await this.secrets.put(JSON.stringify(nextMaterial), {
            operationId: "mcp.oauth.persist",
            traceId: "mcp.oauth.persist",
            spaceId: context.spaceId,
            userId: context.userId,
            botId: "mcp",
            signal: new AbortController().signal,
          })
        : undefined;
      if (stored) {
        await tx.secret.create({
          data: {
            id: stored.id,
            spaceId: context.spaceId,
            userId: context.userId,
            kind: "mcp",
            ciphertext: stored.ciphertext,
          },
        });
      }
      await tx.mcpServer.update({
        where: { id: serverId },
        data: {
          secretId: stored?.id ?? null,
          ...(incrementRevision ? { revision: { increment: 1 } } : {}),
        },
      });
      if (server.secretId && server.secretId !== stored?.id) {
        await tx.secret.deleteMany({ where: { id: server.secretId } });
      }
      return stored?.id;
    });
  }

  private read(ciphertext: string, recordId: string): OAuthMaterial {
    try {
      const value = JSON.parse(this.secrets.load(ciphertext, recordId));
      return value && typeof value === "object" ? (value as OAuthMaterial) : {};
    } catch {
      return {};
    }
  }
}
