import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { StdioServerParameters } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { CallToolResult, ListToolsResult } from "@modelcontextprotocol/sdk/types.js";
import { isLocalhostOrLoopbackIp } from "@rakazo/contracts";
import { cancelResponseBody } from "@rakazo/core";
import { combineSignals } from "./connector-safety.js";

import type { InstalledMcpBin } from "./mcp-package-installer.js";
import {
  isInstalledMcpBin,
  isNpxCommand,
  isPackageRunnerCommand,
} from "./mcp-package-installer.js";

import type { RemoteTransportDependencies, SafeRemoteFetch } from "./remote-mcp.js";
import { createSafeRemoteFetch, listMcpTools } from "./remote-mcp.js";

export type McpRemoteTransport = "streamable-http" | "sse";

export interface McpUrlPolicy {
  maxUrlLength?: number;
  /** Permit plain HTTP only on the configured loopback resource's exact origin.
   * Requests only honour it together with `allowPrivateEndpoint`: loopback is private. */
  allowHttpLocalhost?: boolean;
  /** Permit configured credentials on an explicitly local HTTP endpoint. */
  allowLocalHttpCredentials?: boolean;
  /** Permit RFC1918 / Docker-network hosts when the operator enabled the escape. */
  allowPrivateEndpoint?: boolean;
  /** Hosts allowed after redirects (redirects are rejected by default). */
  allowedHosts?: readonly string[];
}

export interface McpHeaderPolicy {
  /** Additional SDK request headers allowed beyond defaults and configured headers. */
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
  /**
   * Let the official SDK own re-authentication and request retry. `wrapFetch`
   * lets the provider serve the SDK's token refresh itself.
   */
  authProvider?: OAuthClientProvider & {
    wrapFetch?: (fetch: typeof globalThis.fetch) => typeof globalThis.fetch;
  };
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
  /**
   * Launch this managed package bin instead of `command`, with `args` as the bin's own
   * arguments. The allowlist still applies to `command` (the configured launcher, such as
   * `npx`); only bins issued by `ensureMcpPackage` are accepted here.
   */
  installedBin?: InstalledMcpBin;
  maxBufferSize?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** The process exited or never answered; the message carries the tail of its stderr. */
export class McpStdioLaunchError extends Error {
  constructor(
    cause: unknown,
    readonly stderr: string,
  ) {
    const message = cause instanceof Error ? cause.message : String(cause);
    super(stderr ? `${message}\nstderr: ${stderr}` : message, { cause });
    this.name = "McpStdioLaunchError";
  }
}

const STDERR_TAIL_CHARS = 4_096;
/** Terminal colour/cursor sequences (ESC [ ... letter) that npm and friends print. */
const ANSI_ESCAPE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, "g");

/** Keeps the last few KB a process wrote to stderr, without terminal escapes. */
class StderrTail {
  private text = "";

  push(chunk: Buffer | string): void {
    this.text = (this.text + chunk.toString()).slice(-STDERR_TAIL_CHARS * 2);
  }

  toString(): string {
    return this.text.replace(ANSI_ESCAPE, "").trim().slice(-STDERR_TAIL_CHARS);
  }
}

export interface McpClientOptions {
  name?: string;
  version?: string;
  capabilities?: ConstructorParameters<typeof Client>[1];
}

const DEFAULT_HEADERS = ["accept", "content-type", "authorization", "user-agent"];
const RESOURCE_HEADERS = new Set(["mcp-session-id", "mcp-protocol-version", "last-event-id"]);
const DEFAULT_MAX_URL_LENGTH = 2_048;

function validateUrl(raw: string | URL, policy: McpUrlPolicy = {}): URL {
  const url = new URL(raw.toString());
  const max = policy.maxUrlLength ?? DEFAULT_MAX_URL_LENGTH;
  if (url.toString().length > max) throw new Error(`MCP URL exceeds ${max} characters`);
  if (url.username || url.password || url.hash)
    throw new Error("MCP URL must not contain credentials or a fragment");
  const local = isLocalhostOrLoopbackIp(url.hostname);
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && policy.allowHttpLocalhost === true && local) &&
    !(url.protocol === "http:" && policy.allowPrivateEndpoint === true)
  ) {
    throw new Error("MCP remote URL must use HTTPS");
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
  // A local hostname is not authorization: the unguarded loopback fetch below
  // needs the deployment-owner private-endpoint escape as well.
  const localOrigin =
    urlPolicy.allowHttpLocalhost === true &&
    urlPolicy.allowPrivateEndpoint === true &&
    resourceUrl.protocol === "http:" &&
    isLocalhostOrLoopbackIp(resourceUrl.hostname)
      ? resourceUrl.origin
      : undefined;
  const allowed = new Set(
    [
      ...DEFAULT_HEADERS,
      ...(headerPolicy.allowedHeaders ?? []),
      ...Object.keys(headerPolicy.headers ?? {}),
    ].map((header) => header.toLowerCase()),
  );
  const configured = Object.entries(headerPolicy.headers ?? {}).filter(([name]) =>
    allowed.has(name.toLowerCase()),
  );
  const configuredValues = new Map(
    configured.map(([name, value]) => [name.toLowerCase(), value] as const),
  );
  const configuredCredentialValues = new Set(configuredValues.values());
  const configuredNames = new Set(configuredValues.keys());
  const localCredentialHeaders = new Set([
    ...configuredNames,
    "authorization",
    "cookie",
    "proxy-authorization",
  ]);
  const safeRemoteFetch = createSafeRemoteFetch(network.fetch, network.resolveHostname, {
    allowPrivateEndpoint: urlPolicy.allowPrivateEndpoint,
  });
  const request = async (input: Request | URL | string, init?: RequestInit): Promise<Response> => {
    const source = new Request(input, init);
    // OAuth challenges and rediscovery can supply new URLs. Only the explicitly
    // configured local resource origin (including port) may bypass remote policy.
    const url = validateUrl(source.url, {
      ...urlPolicy,
      allowHttpLocalhost: new URL(source.url).origin === localOrigin,
    });
    const headers = new Headers();
    for (const [name, value] of source.headers) {
      const normalized = name.toLowerCase();
      if (RESOURCE_HEADERS.has(normalized)) {
        if (url.origin !== resourceUrl.origin) continue;
      } else if (!allowed.has(normalized)) continue;
      if (url.origin !== resourceUrl.origin && configuredCredentialValues.has(value)) continue;
      headers.set(name, value);
    }
    const localHttp = url.protocol === "http:" && isLocalhostOrLoopbackIp(url.hostname);
    if (localHttp && urlPolicy.allowLocalHttpCredentials !== true) {
      for (const name of [...headers.keys()]) {
        if (localCredentialHeaders.has(name.toLowerCase())) headers.delete(name);
      }
    }
    if (!localHttp && url.origin === resourceUrl.origin) {
      for (const [name, value] of configured) headers.set(name, value);
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
      cancelResponseBody(response);
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
      return await fetchImpl(input, {
        ...init,
        signal: combineSignals(init?.signal ?? undefined, AbortSignal.timeout(4_000)),
      });
    } catch {
      init?.signal?.throwIfAborted();
      return fetchImpl(new URL(url.pathname + url.search, endpointOrigin), sanitizedInit(init));
    }
  };
}

/** Whether a configured stdio command is on the deployment's exact allowlist. */
export function isAllowedStdioCommand(command: string, allowed: readonly string[]): boolean {
  const trimmed = command.trim();
  return trimmed.length > 0 && allowed.includes(trimmed);
}

/** The deployment's stdio settings, as MCP_STDIO_ENABLED and MCP_STDIO_ALLOWED_COMMANDS set them. */
export type McpStdioPolicy = { stdioEnabled?: boolean; allowedCommands?: readonly string[] };

export function mcpStdioAvailable(policy: McpStdioPolicy): boolean {
  return policy.stdioEnabled === true && (policy.allowedCommands?.length ?? 0) > 0;
}

const PACKAGE_RUNNER_REFUSAL = "Only npx can launch packages here";

/** Why this deployment can't run a stdio server with `command`, or undefined when it can. */
export function mcpStdioRefusal(command: string, policy: McpStdioPolicy): string | undefined {
  if (!mcpStdioAvailable(policy)) return "Stdio MCP servers aren't available here";
  if (!isAllowedStdioCommand(command, policy.allowedCommands ?? []))
    return "This stdio command isn't allowed here";
  if (isPackageRunnerCommand(command)) return PACKAGE_RUNNER_REFUSAL;
  return undefined;
}

function stdioParams(options: McpStdioOptions): StdioServerParameters {
  if (!isAllowedStdioCommand(options.command, options.allowedCommands)) {
    throw new Error("MCP stdio command is not in the configured allowlist");
  }
  if (isPackageRunnerCommand(options.command)) throw new Error(PACKAGE_RUNNER_REFUSAL);
  if (options.installedBin !== undefined && !isInstalledMcpBin(options.installedBin)) {
    throw new Error("MCP stdio bin was not installed by Rakazo");
  }
  if (options.installedBin === undefined && isNpxCommand(options.command)) {
    throw new Error("npx only launches a package bin Rakazo installed");
  }
  const command = options.installedBin?.binPath ?? options.command.trim();
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
    const originFetch = withEndpointOriginFallback(url.origin, safeFetch);
    const fetch = options.authProvider?.wrapFetch?.(originFetch) ?? originFetch;
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
    // Always drain stderr: an unread pipe fills up and blocks a chatty server. The tail
    // explains a launch that fails ("not found", a crash) instead of a bare timeout.
    const stderr = new StderrTail();
    transport.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    const signal = combineSignals(options.signal, AbortSignal.timeout(options.timeoutMs ?? 15_000));
    this.connecting = this.client
      .connect(transport, { signal, timeout: options.timeoutMs ?? 15_000 })
      .then(() => {
        this.connected = true;
      })
      .finally(() => {
        this.connecting = undefined;
      });
    try {
      await this.connecting;
    } catch (error) {
      // Let the last stderr chunks of an exited process reach the buffer.
      await new Promise((done) => setImmediate(done));
      throw new McpStdioLaunchError(error, stderr.toString());
    }
  }

  async listTools(options?: { signal?: AbortSignal }): Promise<ListToolsResult> {
    this.assertConnected();
    return { tools: await listMcpTools(this.client, { signal: options?.signal }) };
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
