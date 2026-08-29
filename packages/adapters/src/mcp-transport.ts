import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import {
  StdioClientTransport,
  type StdioServerParameters,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { CallToolResult, ListToolsResult } from "@modelcontextprotocol/sdk/types.js";
import { isLocalMcpHost } from "@rakazo/contracts";
import { combineSignals } from "./connector-safety.js";
import {
  createSafeRemoteFetch,
  type RemoteTransportDependencies,
  type SafeRemoteFetch,
} from "./remote-mcp.js";

export type McpRemoteTransport = "streamable-http" | "sse";

export interface McpUrlPolicy {
  /** Maximum URL length accepted before any network request. */
  maxUrlLength?: number;
  /** Permit plain HTTP only for explicitly local hosts. */
  allowHttpLocalhost?: boolean;
  /** Permit configured credentials on an explicitly local HTTP endpoint. */
  allowLocalHttpCredentials?: boolean;
  /** Hosts allowed after redirects (redirects are rejected by default). */
  allowedHosts?: readonly string[];
}

export interface McpHeaderPolicy {
  /** Headers are copied into requests only when named here. */
  allowedHeaders?: readonly string[];
  headers?: Record<string, string>;
}

export interface McpRemoteOptions {
  url: string | URL;
  transport?: McpRemoteTransport;
  urlPolicy?: McpUrlPolicy;
  headerPolicy?: McpHeaderPolicy;
  /** Opt in to the deprecated HTTP+SSE transport. */
  allowLegacySse?: boolean;
  /** Fall back to SSE only after a fresh Streamable HTTP client fails. */
  fallbackToSse?: boolean;
  /** Let the official SDK own token refresh, re-authentication, and request retry. */
  authProvider?: OAuthClientProvider;
  network?: RemoteTransportDependencies;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface McpStdioOptions {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  /** Exact executable allowlist. Stdio is otherwise disabled. */
  allowedCommands: readonly string[];
  maxBufferSize?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface McpClientOptions {
  name?: string;
  version?: string;
  capabilities?: ConstructorParameters<typeof Client>[1];
}

const DEFAULT_HEADERS = ["accept", "content-type", "authorization", "user-agent"];
const DEFAULT_MAX_URL_LENGTH = 2_048;

function validateUrl(raw: string | URL, policy: McpUrlPolicy = {}): URL {
  const url = new URL(raw.toString());
  const max = policy.maxUrlLength ?? DEFAULT_MAX_URL_LENGTH;
  if (url.toString().length > max) throw new Error(`MCP URL exceeds ${max} characters`);
  if (url.username || url.password || url.hash)
    throw new Error("MCP URL must not contain credentials or a fragment");
  const local = isLocalMcpHost(url.hostname);
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && policy.allowHttpLocalhost === true && local)
  ) {
    throw new Error("MCP remote URL must use HTTPS (HTTP is allowed only for localhost)");
  }
  if (policy.allowedHosts && !policy.allowedHosts.includes(url.hostname)) {
    throw new Error(`MCP host is not in the allowlist: ${url.hostname}`);
  }
  return url;
}

export function secureFetch(
  resourceUrl: URL,
  urlPolicy: McpUrlPolicy,
  headerPolicy: McpHeaderPolicy = {},
  network: RemoteTransportDependencies = {},
): SafeRemoteFetch {
  const allowed = new Set(
    (headerPolicy.allowedHeaders ?? DEFAULT_HEADERS).map((h) => h.toLowerCase()),
  );
  const configured = Object.entries(headerPolicy.headers ?? {}).filter(([name]) =>
    allowed.has(name.toLowerCase()),
  );
  const configuredNames = new Set(
    Object.keys(headerPolicy.headers ?? {}).map((name) => name.toLowerCase()),
  );
  const localCredentialHeaders = new Set([
    ...configuredNames,
    "authorization",
    "cookie",
    "proxy-authorization",
  ]);
  const safeRemoteFetch = createSafeRemoteFetch(
    network.fetch ?? globalThis.fetch,
    network.resolveHostname,
  );
  const request = async (input: Request | URL | string, init?: RequestInit): Promise<Response> => {
    const source = input instanceof Request ? input : new Request(input, init);
    const url = validateUrl(source.url, urlPolicy);
    const headers = new Headers(source.headers);
    const localHttp = url.protocol === "http:" && isLocalMcpHost(url.hostname);
    if (localHttp && urlPolicy.allowLocalHttpCredentials !== true) {
      for (const name of [...headers.keys()]) {
        if (localCredentialHeaders.has(name.toLowerCase())) headers.delete(name);
      }
    }
    if (!localHttp && url.origin === resourceUrl.origin) {
      for (const [name, value] of configured) headers.set(name, value);
    }
    for (const [name, value] of new Headers(init?.headers)) {
      if (
        localHttp &&
        urlPolicy.allowLocalHttpCredentials !== true &&
        localCredentialHeaders.has(name.toLowerCase())
      )
        continue;
      if (allowed.has(name.toLowerCase())) headers.set(name, value);
    }
    // Buffer the body: a re-wrapped Request body is a stream without a replayable
    // source, and undici fails the whole request when a server answers 401 early
    // (the OAuth challenge) instead of draining it.
    const body =
      source.method === "GET" || source.method === "HEAD" ? undefined : await source.arrayBuffer();
    const requestInit = {
      method: source.method,
      headers,
      body,
      redirect: "manual",
      signal: source.signal,
    } satisfies RequestInit;
    const response = localHttp
      ? await (network.fetch ?? globalThis.fetch)(url, requestInit)
      : await safeRemoteFetch(url, requestInit);
    if (response.status >= 300 && response.status < 400) {
      throw new Error("MCP redirects are not permitted; configure the final HTTPS URL explicitly");
    }
    return response;
  };
  const result = request as SafeRemoteFetch;
  result.close = () => safeRemoteFetch.close();
  return result;
}

/**
 * Some providers (Brex) advertise OAuth discovery and registration hosts that
 * are not publicly routable, while mirroring the same well-known documents on
 * the MCP endpoint's own origin. When a request to another origin cannot
 * connect, retry the same path on the endpoint origin before giving up.
 */
export function withEndpointOriginFallback(
  endpointOrigin: string,
  fetchImpl: typeof fetch = fetch,
): typeof fetch {
  // Credentials must not be replayed to a different origin than the one the
  // SDK addressed, so the retry drops auth/session headers.
  const SENSITIVE_RETRY_HEADERS = new Set(["authorization", "cookie", "proxy-authorization"]);
  const sanitizedInit = (init?: RequestInit): RequestInit | undefined => {
    if (!init?.headers) return init;
    const headers = new Headers(init.headers);
    for (const name of [...headers.keys()]) {
      if (SENSITIVE_RETRY_HEADERS.has(name.toLowerCase())) headers.delete(name);
    }
    return { ...init, headers };
  };
  return async (input: Request | URL | string, init?: RequestInit): Promise<Response> => {
    if (input instanceof Request) return fetchImpl(input, init);
    const url = new URL(String(input));
    if (url.origin === endpointOrigin) return fetchImpl(input, init);
    const method = (init?.method ?? "GET").toUpperCase();
    if (method !== "GET" && method !== "HEAD") return fetchImpl(input, init);
    try {
      // Cap the first attempt: an unroutable host otherwise burns the full
      // connect timeout before the fallback gets a chance.
      return await fetchImpl(
        input,
        init?.signal ? init : { ...init, signal: AbortSignal.timeout(4_000) },
      );
    } catch {
      return fetchImpl(new URL(url.pathname + url.search, endpointOrigin), sanitizedInit(init));
    }
  };
}

function stdioParams(options: McpStdioOptions): StdioServerParameters {
  const command = options.command.trim();
  if (!command || !options.allowedCommands.includes(command)) {
    throw new Error("MCP stdio command is not in the configured allowlist");
  }
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(options.env ?? {})) {
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) env[key] = value;
  }
  return {
    command,
    args: options.args ?? [],
    cwd: options.cwd,
    env,
    stderr: "pipe",
    maxBufferSize: options.maxBufferSize,
  };
}

/** A narrow seam around the official SDK, suitable for the agent tool layer. */
export class McpSession {
  client: Client;
  private readonly clientOptions: McpClientOptions;
  private transport?: Transport;
  private remoteFetch?: SafeRemoteFetch;
  private connected = false;
  private connecting?: Promise<void>;

  constructor(options: McpClientOptions = {}) {
    this.clientOptions = options;
    this.client = this.newClient();
  }

  private newClient(): Client {
    return new Client(
      { name: this.clientOptions.name ?? "rakazo", version: this.clientOptions.version ?? "0.1.0" },
      this.clientOptions.capabilities,
    );
  }

  async connectRemote(
    options: McpRemoteOptions,
  ): Promise<{ transport: McpRemoteTransport; usedFallback: boolean }> {
    if (this.connected || this.connecting)
      throw new Error("MCP session is already connected or connecting");
    const url = validateUrl(options.url, options.urlPolicy);
    const safeFetch = secureFetch(
      url,
      options.urlPolicy ?? {},
      options.headerPolicy,
      options.network,
    );
    this.remoteFetch = safeFetch;
    const fetch = withEndpointOriginFallback(url.origin, safeFetch);
    const signal = combineSignals(options.signal, AbortSignal.timeout(options.timeoutMs ?? 15_000));
    let usedFallback = false;
    const connect = async (kind: McpRemoteTransport): Promise<void> => {
      const requestInit: RequestInit = { headers: options.headerPolicy?.headers };
      const transport =
        kind === "streamable-http"
          ? new StreamableHTTPClientTransport(url, {
              fetch,
              requestInit,
              authProvider: options.authProvider,
            })
          : new SSEClientTransport(url, {
              fetch,
              requestInit,
              authProvider: options.authProvider,
              eventSourceInit: { fetch: fetch as never },
            });
      this.transport = transport;
      await this.client.connect(transport, { signal, timeout: options.timeoutMs ?? 15_000 });
      this.connected = true;
    };
    this.connecting = (async () => {
      try {
        await connect(options.transport ?? "streamable-http");
      } catch (error) {
        const canFallback =
          (options.fallbackToSse ?? true) &&
          options.allowLegacySse &&
          (options.transport ?? "streamable-http") === "streamable-http";
        await this.client.close().catch(() => undefined);
        this.connected = false;
        this.transport = undefined;
        if (!canFallback) {
          await this.remoteFetch?.close().catch(() => undefined);
          this.remoteFetch = undefined;
          throw error;
        }
        usedFallback = true;
        // The SDK's documented fallback uses a fresh Client after a failed
        // Streamable HTTP handshake; a Client cannot be reconnected safely.
        this.client = this.newClient();
        try {
          await connect("sse");
        } catch (fallbackError) {
          await this.close();
          throw fallbackError;
        }
      } finally {
        this.connecting = undefined;
      }
    })();
    await this.connecting;
    return {
      transport: usedFallback ? "sse" : (options.transport ?? "streamable-http"),
      usedFallback,
    };
  }

  async connectStdio(options: McpStdioOptions): Promise<void> {
    if (this.connected || this.connecting)
      throw new Error("MCP session is already connected or connecting");
    const transport = new StdioClientTransport(stdioParams(options));
    this.transport = transport;
    const signal = combineSignals(options.signal, AbortSignal.timeout(options.timeoutMs ?? 15_000));
    this.connecting = this.client
      .connect(transport, { signal, timeout: options.timeoutMs ?? 15_000 })
      .then(() => {
        this.connected = true;
      })
      .finally(() => {
        this.connecting = undefined;
      });
    await this.connecting;
  }

  async listTools(options?: { signal?: AbortSignal }): Promise<ListToolsResult> {
    this.assertConnected();
    return this.client.listTools({}, { signal: options?.signal });
  }

  async callTool(
    name: string,
    args: Record<string, unknown> = {},
    options?: { signal?: AbortSignal },
  ): Promise<CallToolResult> {
    this.assertConnected();
    return (await this.client.callTool({ name, arguments: args }, undefined, {
      signal: options?.signal,
    })) as CallToolResult;
  }

  async close(): Promise<void> {
    this.connecting = undefined;
    this.connected = false;
    await this.client.close().catch(() => undefined);
    await this.remoteFetch?.close().catch(() => undefined);
    this.remoteFetch = undefined;
    this.transport = undefined;
  }

  private assertConnected(): void {
    if (!this.connected) throw new Error("MCP session is not connected");
  }
}

export { validateUrl };
