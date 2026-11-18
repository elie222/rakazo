import { lookup } from "node:dns/promises";
import type { LookupFunction } from "node:net";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { ConnectorTool } from "@rakazo/adapter-kit";
import {
  ConnectionSetupError,
  ipVersion,
  isCloudMetadataAddress,
  isCloudMetadataHost,
  isInternalHostname,
  isLinkLocalAddress,
  isLocalhostOrLoopbackIp,
  isLoopbackAddress,
  isNonPublicAddress,
  MCP_APP_READ_TIMEOUT_MS,
  normalizeHost,
} from "@rakazo/contracts";
import { cancelResponseBody } from "@rakazo/core";
import { Agent } from "undici";
import { sensitiveQueryParameter } from "../integrations/connector-http.js";
import { combineSignals } from "../integrations/connector-safety.js";
import type { ResolvedAddress, ResolveHostname } from "../network/network-address.js";
import {
  createAddressCheckedLookup,
  egressRefused,
  withPinnedDnsLookup,
} from "../network/network-address.js";
import { createCheckedProxyDispatcher } from "../network/proxy-dispatcher.js";
import { dispatcherFetch, fetchPairedWithDispatcher } from "../network/undici-fetch.js";
import { composioToolBatch } from "../providers/integration/composio/composio-batch.js";
import { credentialDigest } from "../secrets/credential-digest.js";
import { mcpToolAppResourceUri, mcpToolVisibleToModel } from "./mcp-app.js";
import type { McpCallAsker } from "./mcp-elicitation.js";
import {
  callMcpToolAsking,
  MCP_ANSWER_ALLOWANCE_MS,
  McpElicitationRouter,
  newRemoteMcpClient,
} from "./mcp-elicitation.js";
import { limitMcpResponseBody } from "./mcp-response-limit.js";
import { withoutDuplicatedStructuredText } from "./mcp-structured-text.js";

const DEFAULT_MAX_MCP_TOOLS = 250;
const DEFAULT_MAX_MCP_PAGES = 20;
const MCP_TIMEOUT_MS = 30_000;
/** How long a tool call may go without an answer or a progress report. Real calls (a
 * search across mail folders, a document export, a gateway running a program for up to
 * five minutes without reporting progress) take minutes; connecting and listing stay short. */
export const MCP_TOOL_TIMEOUT_MS = 6 * 60_000;
/** Progress restarts the wait, but never past this. The run's own cancellation still
 * ends a call at any time. */
export const MCP_TOOL_MAX_TOTAL_MS = 15 * 60_000;
/** The HTTP client's own waits (five minutes by default) sit past every MCP wait above, the
 * time a person may spend answering the server's questions included, so those decide when a call
 * ends and the client only catches a connection nobody closes. */
export const MCP_HTTP_TIMEOUTS = {
  headersTimeout: MCP_TOOL_MAX_TOTAL_MS + MCP_ANSWER_ALLOWANCE_MS + 60_000,
  bodyTimeout: MCP_TOOL_MAX_TOTAL_MS + MCP_ANSWER_ALLOWANCE_MS + 60_000,
} as const;
const MAX_RESULT_BYTES = 1_000_000;

export type { ResolveHostname } from "../network/network-address.js";

export interface RemoteUrlPolicy {
  /** Deployment-owner escape for loopback / LAN / Docker-network endpoints. Default off. */
  allowPrivateEndpoint?: boolean;
}

export interface RemoteTransportDependencies {
  fetch?: typeof globalThis.fetch;
  resolveHostname?: ResolveHostname;
}

export interface RemoteMcpOptions extends RemoteTransportDependencies, RemoteUrlPolicy {
  endpoint: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** Reuse one MCP session for every call that carries the same scope (one run
   * and one server) instead of opening a session per call. Requires `sessionPool`. */
  sessionScope?: string;
  /** Cache holding the reusable sessions. Scope-keyed, so sessions never leak
   * between runs, users, spaces or servers. */
  sessionPool?: RemoteMcpSessionCache;
  /** The run whose sessions these are: `sessionPool.endRun(runId)` closes them
   * when the run ends for good. A per-call `signal` only cancels its own call. */
  sessionRunId?: string;
  /** Let tool calls wait minutes (`MCP_TOOL_TIMEOUT_MS`, renewed by progress up to
   * `MCP_TOOL_MAX_TOTAL_MS`), for sources whose tools do long work. Otherwise 30 seconds. */
  longToolCalls?: boolean;
  /** Tell the server it may ask the person questions mid-call (form elicitation). */
  elicitation?: boolean;
  /** Who a call's questions go to; without an `ask` they are declined. */
  asker?: McpCallAsker;
}

/** A reusable Streamable HTTP session failed below the protocol: the guarded
 * fetch could not deliver the request. Unlike a server's own error, this says
 * nothing about whether the server ran the request. */
export class RemoteMcpTransportError extends Error {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, options);
    this.name = "RemoteMcpTransportError";
  }
}

/** The guarded fetch failed once it may have sent the request, so its headers may have reached
 * the server. A refusal, or a failure that proves no connection was made, is a plain error. */
export class RemoteRequestSentError extends Error {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, options);
    this.name = "RemoteRequestSentError";
  }
}

export class ConnectorRedirectError extends Error {
  constructor() {
    super("Connector redirects are not allowed");
    this.name = "ConnectorRedirectError";
  }
}

export interface SafeRemoteFetch {
  (input: string | URL | Request, init?: RequestInit): Promise<Response>;
  close(): Promise<void>;
}

const resolveHostname: ResolveHostname = (hostname) =>
  lookup(hostname, { all: true, verbatim: true });

/** The ConnectorTool fields every MCP server's tool maps the same way; name, description
 * and app routing differ by caller. */
export function mcpToolFields(
  tool: Tool,
): Pick<ConnectorTool, "inputSchema" | "readOnly" | "batch"> {
  return {
    inputSchema: tool.inputSchema as Record<string, unknown>,
    readOnly: tool.annotations?.readOnlyHint,
    batch: composioToolBatch(tool.name),
  };
}

export async function listRemoteMcpTools(options: RemoteMcpOptions): Promise<ConnectorTool[]> {
  const list = async (client: Client, signal: AbortSignal | undefined): Promise<ConnectorTool[]> =>
    (await listMcpTools(client, { signal, timeout: MCP_TIMEOUT_MS })).tools.map((tool) => ({
      name: tool.name,
      description: tool.description ?? tool.title ?? tool.name,
      ...mcpToolFields(tool),
      appResourceUri: mcpToolAppResourceUri(tool),
    }));
  return withScopedMcpClient(options, list);
}

type McpRun<T> = (
  client: Client,
  signal: AbortSignal | undefined,
  router: McpElicitationRouter | undefined,
) => Promise<T>;

function positiveIntegerOrDefault(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/** Follow `tools/list` cursors within the shared caps, with the shortest `ttlMs` any page sent.
 * Tools only a server's own app may call are left out: the model never sees them. */
export async function listMcpTools(
  client: Client,
  options: RequestOptions,
): Promise<{ tools: Tool[]; ttlMs?: number }> {
  const maxTools = positiveIntegerOrDefault(process.env.MCP_MAX_TOOLS, DEFAULT_MAX_MCP_TOOLS);
  const maxPages = positiveIntegerOrDefault(process.env.MCP_MAX_PAGES, DEFAULT_MAX_MCP_PAGES);
  const tools: Tool[] = [];
  let ttlMs: number | undefined;
  let cursor: string | undefined;
  for (let page = 0; page < maxPages && tools.length < maxTools; page += 1) {
    const result = await client.listTools(cursor ? { cursor } : undefined, options);
    const visible = result.tools.filter(mcpToolVisibleToModel);
    tools.push(...visible.slice(0, maxTools - tools.length));
    if (typeof result.ttlMs === "number" && Number.isFinite(result.ttlMs))
      ttlMs = Math.min(ttlMs ?? Number.POSITIVE_INFINITY, Math.max(0, result.ttlMs));
    cursor = result.nextCursor;
    if (!cursor) break;
  }
  return { tools, ttlMs };
}

/** Call through the guarded transport, optionally projecting before the final byte limit. */
export async function callRemoteMcpTool(
  options: RemoteMcpOptions,
  toolName: string,
  args: Record<string, unknown>,
  projectResult?: (result: unknown) => unknown,
): Promise<unknown> {
  const long = options.longToolCalls === true;
  return withScopedMcpClient(
    options,
    (client, signal, router) =>
      callMcpTool(client, signal, router, options.asker, toolName, args, long, projectResult),
    // A long call keeps its own clock, which leaves out the time a person spends answering.
    long ? null : MCP_TIMEOUT_MS,
  );
}

/** Read one resource through the same guarded transport and run-scoped session as calls. */
export async function readRemoteMcpResource(
  options: RemoteMcpOptions,
  uri: string,
): Promise<{ contents?: unknown }> {
  return withScopedMcpClient(options, (client, signal) =>
    // The call already answered; its app gets a shorter wait than a call.
    client.readResource({ uri }, { signal, timeout: MCP_APP_READ_TIMEOUT_MS }),
  );
}

async function callMcpTool(
  client: Client,
  signal: AbortSignal | undefined,
  router: McpElicitationRouter | undefined,
  asker: McpCallAsker | undefined,
  toolName: string,
  args: Record<string, unknown>,
  long: boolean,
  projectResult?: (result: unknown) => unknown,
): Promise<unknown> {
  const result =
    long || router
      ? await callMcpToolAsking(client, router ?? new McpElicitationRouter(), toolName, args, {
          signal,
          idleMs: long ? MCP_TOOL_TIMEOUT_MS : MCP_TIMEOUT_MS,
          totalMs: long ? MCP_TOOL_MAX_TOTAL_MS : MCP_TIMEOUT_MS,
          asker,
        })
      : await client.callTool({ name: toolName, arguments: args }, undefined, {
          signal,
          timeout: MCP_TIMEOUT_MS,
        });
  const isError = result.isError === true;
  const envelope = {
    content: withoutDuplicatedStructuredText(result.content, result.structuredContent, isError),
    structuredContent: result.structuredContent,
    isError,
    _meta: result._meta,
  };
  // Providers may extract a bounded domain result before the MCP envelope
  // consumes the budget. The final limit still applies.
  return limitRemoteMcpPayload(projectResult ? projectResult(envelope) : envelope);
}

/** One client per call, or the run-scoped session when `options` carries one.
 * `deadlineMs` bounds the whole operation; each request also has its own timeout. `null` leaves
 * the bound to the request's own clock. */
function withScopedMcpClient<T>(
  options: RemoteMcpOptions,
  run: McpRun<T>,
  deadlineMs: number | null = MCP_TIMEOUT_MS,
): Promise<T> {
  if (options.sessionPool && options.sessionScope !== undefined) {
    return options.sessionPool.withSession(
      options as RemoteMcpOptions & { sessionScope: string },
      run,
      deadlineMs,
    );
  }
  return withRemoteMcpClient(options, run, deadlineMs);
}

async function withRemoteMcpClient<T>(
  options: RemoteMcpOptions,
  run: McpRun<T>,
  deadlineMs: number | null,
): Promise<T> {
  const policy = { allowPrivateEndpoint: options.allowPrivateEndpoint };
  const endpoint = await assertSafeRemoteUrl(
    options.endpoint,
    options.resolveHostname ?? resolveHostname,
    policy,
  );
  const signal = combineSignals(
    options.signal,
    deadlineMs === null ? undefined : AbortSignal.timeout(deadlineMs),
  );
  const safeFetch = createSafeRemoteFetch(
    options.fetch,
    options.resolveHostname ?? resolveHostname,
    policy,
    undefined,
    MCP_HTTP_TIMEOUTS,
  );
  const transport = new StreamableHTTPClientTransport(endpoint, {
    requestInit: {
      headers: options.headers,
      redirect: "manual",
      signal,
    },
    fetch: async (input, init) => limitMcpResponseBody(await safeFetch(input, init), init?.headers),
  });
  const router = options.elicitation ? new McpElicitationRouter() : undefined;
  const client = newRemoteMcpClient(router);
  try {
    await client.connect(transport, { signal, timeout: MCP_TIMEOUT_MS });
    return await run(client, signal, router);
  } finally {
    await client.close().catch(() => undefined);
    await safeFetch.close().catch(() => undefined);
  }
}

/** How long a run-scoped session survives its last call. Also the bound for a
 * run waiting for user input or takeover: past it, the next call reconnects. */
export const DEFAULT_MCP_SESSION_IDLE_MS = 10 * 60_000;
/** Best-effort bound on the terminating DELETE sent while closing a session. */
const MCP_SESSION_CLOSE_MS = 5_000;

type ScopedMcpSession = {
  key: string;
  client: Client;
  transport: StreamableHTTPClientTransport;
  safeFetch: SafeRemoteFetch;
  lastUsedAt: number;
  inFlight: number;
  closed: boolean;
  /** The client's own transport closed, unlike a server's JSON-RPC error response. */
  connectionClosed: boolean;
  /** The run this session belongs to, matched by `endRun`. */
  runId?: string;
  /** Present when the session told the server it may ask questions mid-call. */
  elicitation?: McpElicitationRouter;
};

/** Sessions one Streamable HTTP server-side state can rely on, shared by every
 * call with the same scope (one run, one server) and closed at run end
 * (`endRun`), after the idle bound, or when the transport breaks. A cache
 * belongs to the process: a run that resumes elsewhere just opens a new session. */
export class RemoteMcpSessionCache {
  private readonly sessions = new Map<string, ScopedMcpSession>();
  private readonly connecting = new Map<string, Promise<ScopedMcpSession>>();
  /** Sessions already dropped from reuse whose last call is still running; the
   * last of those calls closes them, so a sibling failure never cuts off a
   * response that may belong to a committed write. */
  private readonly retiring = new Set<ScopedMcpSession>();
  private reaper?: ReturnType<typeof setInterval>;

  constructor(
    /** 0 keeps sessions until `close()`. */
    private readonly idleMs: number = DEFAULT_MCP_SESSION_IDLE_MS,
    private readonly now: () => number = Date.now,
  ) {}

  async withSession<T>(
    options: RemoteMcpOptions & { sessionScope: string },
    run: McpRun<T>,
    deadlineMs: number | null = MCP_TIMEOUT_MS,
  ): Promise<T> {
    const key = remoteMcpSessionKey(options);
    for (let attempt = 0; ; attempt += 1) {
      const session = await this.sessionFor(key, options);
      session.inFlight += 1;
      const controller = new AbortController();
      const deadlineReason = new DOMException("Timed out", "TimeoutError");
      const deadline =
        deadlineMs === null
          ? undefined
          : setTimeout(() => controller.abort(deadlineReason), deadlineMs);
      const onAbort = () => controller.abort(options.signal?.reason);
      if (options.signal?.aborted) onAbort();
      else options.signal?.addEventListener("abort", onAbort, { once: true });
      const signal = controller.signal;
      try {
        return await run(session.client, signal, session.elicitation);
      } catch (error) {
        // The server rejected the session id before running the request, so a
        // fresh session can replay it once without doubling a write. Closing the
        // dead session (a bounded DELETE, then teardown) must not delay the
        // replay or the error, so it runs in the background.
        if (attempt === 0 && isMcpSessionGoneError(error)) {
          void this.drop(session);
          continue;
        }
        // The SDK stops waiting at the deadline but leaves the HTTP request
        // running on the transport; only closing the session aborts it and
        // tells the server to drop the work, as a one-off session does. The
        // combined signal keeps the reason of whichever signal fired first.
        const timedOut =
          (signal.aborted && signal.reason === deadlineReason) || isMcpWaitTimeout(error);
        if (brokeMcpSession(session, error) || timedOut) void this.drop(session);
        throw error;
      } finally {
        clearTimeout(deadline);
        options.signal?.removeEventListener("abort", onAbort);
        session.inFlight -= 1;
        session.lastUsedAt = this.now();
        // The last call on a dropped session retires it in the background, so
        // the replay or the error above is never delayed by the closing DELETE.
        if (session.inFlight === 0 && this.retiring.delete(session))
          void closeMcpSession(session).catch(() => undefined);
      }
    }
  }

  /** Close every session one run opened. The executor calls this when the run
   * ends for good on this worker; a run that ended elsewhere, was cancelled
   * while waiting or never resumed is bounded by the idle reaper instead. */
  endRun(runId: string): void {
    for (const session of [...this.sessions.values()]) {
      if (session.runId === runId) void this.drop(session);
    }
  }

  /** Close every session; for shutdown. */
  async close(): Promise<void> {
    if (this.reaper) clearInterval(this.reaper);
    this.reaper = undefined;
    await Promise.allSettled([...this.connecting.values()]);
    for (let pass = 0; pass < 2; pass += 1) {
      // A second sweep catches a session whose connect resolved during the first.
      const sessions = [...this.sessions.values(), ...this.retiring];
      this.sessions.clear();
      await Promise.allSettled(sessions.map((session) => closeMcpSession(session)));
    }
  }

  /** Close sessions unused for `idleMs`. Returns how many were closed. */
  async reapIdle(now = this.now()): Promise<number> {
    if (this.idleMs <= 0) return 0;
    const idle = [...this.sessions.values()].filter(
      (session) => session.inFlight === 0 && now - session.lastUsedAt >= this.idleMs,
    );
    let closed = 0;
    for (const session of idle) {
      // Re-check at drop time: a call that ran while an earlier candidate's
      // DELETE was in flight renewed this session, so it is no longer idle.
      if (
        this.sessions.get(session.key) !== session ||
        session.inFlight !== 0 ||
        now - session.lastUsedAt < this.idleMs
      )
        continue;
      closed += 1;
      await this.drop(session);
    }
    return closed;
  }

  private async sessionFor(key: string, options: RemoteMcpOptions): Promise<ScopedMcpSession> {
    const existing = this.sessions.get(key);
    if (existing && !existing.closed) {
      existing.lastUsedAt = this.now();
      return existing;
    }
    if (existing) this.sessions.delete(key);
    let pending = this.connecting.get(key);
    if (!pending) {
      pending = this.connectSession(key, options).finally(() => {
        if (this.connecting.get(key) === pending) this.connecting.delete(key);
      });
      this.connecting.set(key, pending);
      this.startReaper();
    }
    const session = await pending;
    // Another caller's failure may have closed this session between the shared
    // connect resolving and this caller resuming; connect again instead of
    // handing out a closed client.
    if (session.closed) return this.sessionFor(key, options);
    if (!this.sessions.has(key)) this.sessions.set(key, session);
    session.lastUsedAt = this.now();
    return session;
  }

  private async connectSession(key: string, options: RemoteMcpOptions): Promise<ScopedMcpSession> {
    const policy = { allowPrivateEndpoint: options.allowPrivateEndpoint };
    const endpoint = await assertSafeRemoteUrl(
      options.endpoint,
      options.resolveHostname ?? resolveHostname,
      policy,
    );
    const safeFetch = createSafeRemoteFetch(
      options.fetch,
      options.resolveHostname ?? resolveHostname,
      policy,
      undefined,
      MCP_HTTP_TIMEOUTS,
    );
    const transport = new StreamableHTTPClientTransport(endpoint, {
      requestInit: {
        headers: options.headers,
        redirect: "manual",
      },
      fetch: async (input, init) => {
        let response: Response;
        try {
          response = await safeFetch(input, init);
        } catch (error) {
          if (error instanceof ConnectorRedirectError) throw error;
          throw new RemoteMcpTransportError(
            error instanceof Error ? error.message : String(error),
            { cause: error },
          );
        }
        return limitMcpResponseBody(response, init?.headers);
      },
    });
    const elicitation = options.elicitation ? new McpElicitationRouter() : undefined;
    const client = newRemoteMcpClient(elicitation);
    const session: ScopedMcpSession = {
      elicitation,
      key,
      client,
      transport,
      safeFetch,
      lastUsedAt: this.now(),
      inFlight: 0,
      closed: false,
      connectionClosed: false,
      runId: options.sessionRunId,
    };
    // The protocol rejects pending work only after this fires, so the flag is set
    // before any ConnectionClosed error of this session can be classified.
    const previousOnClose = client.onclose;
    client.onclose = () => {
      session.connectionClosed = true;
      previousOnClose?.();
    };
    try {
      await client.connect(transport, { signal: options.signal, timeout: MCP_TIMEOUT_MS });
    } catch (error) {
      await closeMcpSession(session).catch(() => undefined);
      throw error;
    }
    return session;
  }

  /** Stop reusing a session at once, like `McpConnector.evict`: new calls open
   * a fresh session, but calls still in flight keep their responses — the last
   * of them closes this one (the terminating DELETE, then teardown). */
  private async drop(session: ScopedMcpSession): Promise<void> {
    if (this.sessions.get(session.key) === session) this.sessions.delete(session.key);
    if (session.inFlight > 0) {
      this.retiring.add(session);
      return;
    }
    await closeMcpSession(session).catch(() => undefined);
  }

  private startReaper(): void {
    if (this.reaper || this.idleMs <= 0) return;
    this.reaper = setInterval(
      () => void this.reapIdle().catch(() => undefined),
      Math.max(1_000, Math.min(this.idleMs / 2, 60_000)),
    );
    this.reaper.unref?.();
  }
}

/** Identity of a reusable session: the run-scope plus everything that decided
 * how the session was opened, so rotated credentials or a changed policy never
 * reuse a session opened as someone or somewhere else. */
function remoteMcpSessionKey(options: RemoteMcpOptions & { sessionScope: string }): string {
  return JSON.stringify([
    options.sessionScope,
    options.endpoint,
    options.allowPrivateEndpoint === true,
    options.elicitation === true,
    credentialDigest(JSON.stringify(options.headers ?? {})),
  ]);
}

async function closeMcpSession(session: ScopedMcpSession): Promise<void> {
  if (session.closed) return;
  session.closed = true;
  // Ask the server to drop the session (spec: HTTP DELETE with the session id)
  // before the client teardown aborts every pending request.
  await Promise.race([
    session.transport.terminateSession().catch(() => undefined),
    new Promise((resolve) => setTimeout(resolve, MCP_SESSION_CLOSE_MS).unref?.()),
  ]);
  await session.client.close().catch(() => undefined);
  await session.safeFetch.close().catch(() => undefined);
}

/** A saved MCP endpoint is stored and shown in plaintext, so its credentials belong in headers. */
export function assertNoMcpEndpointCredential(endpoint: string): void {
  const name = sensitiveQueryParameter(new URL(endpoint));
  if (name) throw new ConnectionSetupError(`Put ${name} in a header instead of the server URL`);
}

export async function assertSafeRemoteUrl(
  value: string,
  resolve: ResolveHostname = resolveHostname,
  policy: RemoteUrlPolicy = {},
): Promise<URL> {
  return (await inspectSafeRemoteUrl(value, resolve, policy)).url;
}

async function inspectSafeRemoteUrl(
  value: string,
  resolve: ResolveHostname,
  policy: RemoteUrlPolicy = {},
): Promise<{ url: URL; addresses: ResolvedAddress[] }> {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConnectionSetupError("Connector URL is invalid");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ConnectionSetupError("Connector URL must use HTTPS");
  }
  if (url.username || url.password)
    throw new ConnectionSetupError("Connector URL must not contain credentials");
  if (url.hash) throw new ConnectionSetupError("Connector URL must not contain a fragment");
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (isCloudMetadataHost(hostname))
    throw egressRefused(hostname, new ConnectionSetupError("Connector URL targets a private host"));
  // Loopback is a private endpoint too: only the private-endpoint escape reaches it.
  const allowPrivate = policy.allowPrivateEndpoint === true;
  const privateHost = isPrivateRemoteMcpHostname(hostname);
  const literal = literalAddresses(hostname);
  // Name the setting only where it surely lifts the refusal: link-local stays blocked with it on,
  // and a private-looking name may still resolve to a public address.
  const settingLifts = literal
    ? !literal.some((entry) => isAlwaysBlockedAddress(entry.address))
    : url.protocol === "http:" && isLocalhostOrLoopbackIp(hostname);
  const settingHint =
    privateHost && settingLifts
      ? " Set MCP_ALLOW_PRIVATE_ENDPOINT=true on the API and worker to allow it."
      : "";
  if (url.protocol === "http:" && !allowPrivate) {
    throw new ConnectionSetupError(
      settingHint ? `Connector URL must use HTTPS.${settingHint}` : "Connector URL must use HTTPS",
    );
  }
  if (privateHost && !allowPrivate) {
    throw egressRefused(
      hostname,
      new ConnectionSetupError(
        `Connector URL targets a private host${settingHint ? `.${settingHint}` : ""}`,
      ),
    );
  }
  if (url.protocol === "http:" && isLocalhostOrLoopbackIp(hostname)) {
    return { url, addresses: literal ?? [] };
  }
  const addresses = literal ?? (await resolve(hostname));
  try {
    assertAllowedAddresses(addresses, policy);
  } catch (error) {
    throw egressRefused(hostname, error);
  }
  if (url.protocol === "http:" && addresses.some((entry) => !isNonPublicAddress(entry.address))) {
    throw new ConnectionSetupError("Connector URL must use HTTPS");
  }
  return { url, addresses };
}

function requestInitWithHost(url: URL, init: RequestInit): RequestInit {
  const headers = new Headers(init.headers);
  headers.set("host", url.host);
  return { ...init, headers };
}

function literalAddresses(hostname: string): ResolvedAddress[] | undefined {
  const family = ipVersion(hostname);
  if (family === 0) return undefined;
  return [{ address: hostname, family }];
}

export function createSafeRemoteFetch(
  baseFetch?: typeof globalThis.fetch,
  resolve: ResolveHostname = resolveHostname,
  policy: RemoteUrlPolicy = {},
  /** Called once the destination is checked, just before the request is sent; a throw stops it. */
  beforeSend?: () => void,
  /** The HTTP client's waits for headers and between body chunks; its defaults otherwise. */
  responseTimeouts?: { headersTimeout: number; bodyTimeout: number },
): SafeRemoteFetch {
  const dispatcher = createCheckedProxyDispatcher(
    resolve,
    (addresses, hostname) => assertSafeRemoteAddresses(addresses, hostname, policy),
    undefined,
    responseTimeouts,
  );
  // Injected fetches are not given this Agent; they keep the original hostname
  // for TLS/SNI and pin TCP to the already-validated address through dns.lookup.
  const usePackageFetch = fetchPairedWithDispatcher(baseFetch) === dispatcherFetch;
  const safeFetch = async (input: string | URL | Request, init?: RequestInit) => {
    if (typeof input !== "string" && !(input instanceof URL)) {
      throw new Error("Connector fetch requires a URL, not a Request");
    }
    const { url, addresses } = await inspectSafeRemoteUrl(String(input), resolve, policy);
    beforeSend?.();
    let response: Response;
    try {
      const requestInit = { ...init, redirect: "manual" as const };
      response = usePackageFetch
        ? await dispatcherFetch(url, {
            ...requestInit,
            dispatcher,
          } as RequestInit & { dispatcher: Agent })
        : await withPinnedDnsLookup(url.hostname, addresses, () =>
            baseFetch!(url, requestInitWithHost(url, requestInit)),
          );
    } catch (error) {
      throw transportFailure(url, error);
    }
    if (response.status >= 300 && response.status < 400) {
      cancelResponseBody(response);
      throw new ConnectorRedirectError();
    }
    return response;
  };
  const result = safeFetch as SafeRemoteFetch;
  result.close = () => dispatcher.close();
  return result;
}

function assertPrivateAddresses(addresses: ResolvedAddress[]): void {
  if (addresses.length === 0) {
    throw new Error("Private fetch URL did not resolve to any address");
  }
  // The classifiers read IPv4-mapped forms (dotted or hex) themselves, so
  // ::ffff:a9fe:a9fe stays blocked as metadata.
  if (
    addresses.some(
      ({ address }) =>
        isCloudMetadataAddress(address) ||
        isLinkLocalAddress(address) ||
        !isNonPublicAddress(address),
    )
  ) {
    throw new Error("Private fetch URL resolved to a non-private address");
  }
}

/** Same transport as `createSafeRemoteFetch`, inverted: the caller holds owner
 * authorization to reach its own network, so every resolved address must be
 * private (cloud metadata endpoints stay blocked) instead of public. */
export function createPrivateNetworkFetch(
  baseFetch?: typeof globalThis.fetch,
  resolve: ResolveHostname = resolveHostname,
  /** As for `createSafeRemoteFetch`. */
  beforeSend?: () => void,
): SafeRemoteFetch {
  const dispatcher = new Agent({
    connect: { lookup: createAddressCheckedLookup(resolve, assertPrivateAddresses) },
  });
  const usePackageFetch = fetchPairedWithDispatcher(baseFetch) === dispatcherFetch;
  const privateFetch = async (input: string | URL | Request, init?: RequestInit) => {
    if (typeof input !== "string" && !(input instanceof URL)) {
      throw new Error("Connector fetch requires a URL, not a Request");
    }
    const url = new URL(String(input));
    if (url.username || url.password || url.hash) {
      throw new Error("Private fetch URL must not contain credentials or a fragment");
    }
    const addresses = await resolve(url.hostname.replace(/^\[|\]$/g, ""));
    assertPrivateAddresses(addresses);
    beforeSend?.();
    let response: Response;
    try {
      const requestInit = { ...init, redirect: "manual" as const };
      response = usePackageFetch
        ? await dispatcherFetch(url, {
            ...requestInit,
            dispatcher,
          } as RequestInit & { dispatcher: Agent })
        : await withPinnedDnsLookup(url.hostname, addresses, () =>
            baseFetch!(url, requestInitWithHost(url, requestInit)),
          );
    } catch (error) {
      throw transportFailure(url, error);
    }
    if (response.status >= 300 && response.status < 400) {
      cancelResponseBody(response);
      throw new RemoteRequestSentError("Private fetch redirects are not allowed");
    }
    return response;
  };
  const result = privateFetch as SafeRemoteFetch;
  result.close = () => dispatcher.close();
  return result;
}

const MAX_CAUSE_DEPTH = 5;

/** The server's certificate failed the client's own checks during the handshake. */
export const TLS_CERTIFICATE_CODES: ReadonlySet<string> = new Set([
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "CERT_REVOKED",
  "CERT_UNTRUSTED",
  "CERT_SIGNATURE_FAILURE",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);

/**
 * Codes that prove no connection was made, whichever call failed: the name did not resolve, the
 * connection was not made in time, or the server's certificate failed the client's own checks
 * during the handshake, before the request is written. A TLS record error may come once the
 * session is up, so it isn't here.
 */
const NEVER_CONNECTED_CODES = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "EAI_FAIL",
  "ENODATA",
  "UND_ERR_CONNECT_TIMEOUT",
  ...TLS_CERTIFICATE_CODES,
]);

/** Any socket error, but only from the connect call: once connected the same codes say nothing. */
const CONNECT_SYSCALL = "connect";

/** By code and failed call only, through `cause` and every address a dual-stack connect tried. */
function neverConnected(error: unknown, depth = 0): boolean {
  if (depth >= MAX_CAUSE_DEPTH || !(error instanceof Error)) return false;
  if (error instanceof AggregateError)
    return (
      error.errors.length > 0 && error.errors.every((inner) => neverConnected(inner, depth + 1))
    );
  const { code, syscall } = error as { code?: unknown; syscall?: unknown };
  if (code !== undefined)
    return (
      typeof code === "string" && (NEVER_CONNECTED_CODES.has(code) || syscall === CONNECT_SYSCALL)
    );
  return neverConnected(error.cause, depth + 1);
}

/** A failure that may have sent the request counts as sent, so a use is never missed. */
function transportFailure(url: URL, error: unknown): Error {
  const detail = transportFailureDetail(error);
  const message = `Could not reach ${url.host}${detail ? `: ${detail}` : ""}`;
  return neverConnected(error)
    ? new Error(message, { cause: error })
    : new RemoteRequestSentError(message, { cause: error });
}

/** undici reports refused ports, unreachable hosts, DNS misses and TLS errors
 * alike as `TypeError: fetch failed` and keeps the actionable reason in `cause`
 * (or in the per-address errors of a happy-eyeballs AggregateError). */
function transportFailureDetail(error: unknown, depth = 0): string | undefined {
  if (depth >= MAX_CAUSE_DEPTH || !(error instanceof Error)) return undefined;
  if (error instanceof AggregateError) {
    for (const inner of error.errors) {
      const detail = transportFailureDetail(inner, depth + 1);
      if (detail) return detail;
    }
  }
  return (
    transportFailureDetail(error.cause, depth + 1) ??
    (error.message === "fetch failed" ? undefined : error.message)
  );
}

export function createSafeLookup(
  resolve: ResolveHostname = resolveHostname,
  policy: RemoteUrlPolicy = {},
): LookupFunction {
  return createAddressCheckedLookup(resolve, (addresses, hostname) =>
    assertSafeRemoteAddresses(addresses, hostname, policy),
  );
}

function assertSafeRemoteAddresses(
  addresses: ResolvedAddress[],
  hostname: string,
  policy: RemoteUrlPolicy,
): void {
  // Loopback stays allowed under the deployment owner's private-endpoint escape.
  if (
    policy.allowPrivateEndpoint === true &&
    isLocalhostOrLoopbackIp(hostname.replace(/^\[|\]$/g, ""))
  ) {
    assertLoopbackAddresses(addresses);
    return;
  }
  assertAllowedAddresses(addresses, policy);
}

/** Reserved local names (localhost, .local, .internal, Docker Desktop) and non-public literals. */
export function isPrivateRemoteMcpHostname(hostname: string): boolean {
  const normalized = normalizeHost(hostname);
  return (
    isInternalHostname(normalized) ||
    (ipVersion(normalized) !== 0 && isNonPublicAddress(normalized))
  );
}

function assertLoopbackAddresses(addresses: ResolvedAddress[]): void {
  if (addresses.length === 0 || addresses.some((entry) => !isLoopbackAddress(entry.address))) {
    throw new ConnectionSetupError("Connector URL resolves to a private address");
  }
}

function assertAllowedAddresses(addresses: ResolvedAddress[], policy: RemoteUrlPolicy): void {
  if (policy.allowPrivateEndpoint === true) {
    assertUnmixedAddresses(addresses);
    return;
  }
  assertPublicAddresses(addresses);
}

/** Link-local stays blocked even with the private-endpoint setting: that range holds cloud metadata, same as private credential fetches. */
function isAlwaysBlockedAddress(address: string): boolean {
  return isCloudMetadataAddress(address) || isLinkLocalAddress(address);
}

function assertUnmixedAddresses(addresses: ResolvedAddress[]): void {
  if (addresses.length === 0) {
    throw new ConnectionSetupError("Connector URL resolves to a private address");
  }
  if (addresses.some((entry) => isAlwaysBlockedAddress(entry.address))) {
    throw new ConnectionSetupError("Connector URL resolves to a private address");
  }
  const hasPrivate = addresses.some((entry) => isNonPublicAddress(entry.address));
  const hasPublic = addresses.some((entry) => !isNonPublicAddress(entry.address));
  if (hasPrivate && hasPublic) {
    throw new ConnectionSetupError("Connector URL resolves to a private address");
  }
}

/** Tailnet (*.ts.net) answers are private addresses too, so they need the private-endpoint escape. */
function assertPublicAddresses(addresses: ResolvedAddress[]): void {
  if (addresses.length === 0) {
    throw new ConnectionSetupError("Connector URL resolves to a private address");
  }
  if (
    addresses.some(
      (entry) => isCloudMetadataAddress(entry.address) || isNonPublicAddress(entry.address),
    )
  ) {
    throw new ConnectionSetupError("Connector URL resolves to a private address");
  }
}

export function limitRemoteMcpPayload(value: unknown): unknown {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) return value;
  if (Buffer.byteLength(serialized, "utf8") <= MAX_RESULT_BYTES) return value;
  const bytes = Buffer.allocUnsafe(MAX_RESULT_BYTES);
  const written = bytes.write(serialized, 0, MAX_RESULT_BYTES, "utf8");
  return {
    truncated: true,
    content: bytes.toString("utf8", 0, written),
  };
}

/** Whether the server rejected the request because it no longer knows the
 * session: the request never ran there, so a fresh session may replay it. */
export function isMcpSessionGoneError(error: unknown): boolean {
  if (!(error instanceof StreamableHTTPError)) return false;
  return (
    error.code === 404 ||
    (error.code === 400 &&
      /\bBad Request: (?:Server not initialized|No valid session ID(?: provided| or initialization request)?|Mcp-Session-Id header is required)(?="|$)/i.test(
        error.message,
      ))
  );
}

/** The SDK's own wait for an answer (a tool call without progress) ran out. A cancel uses
 * the same code, but only the SDK's timers attach how long they waited. */
function isMcpWaitTimeout(error: unknown): boolean {
  if (!(error instanceof McpError) || error.code !== ErrorCode.RequestTimeout) return false;
  const data = error.data;
  return (
    typeof data === "object" &&
    data !== null &&
    ("timeout" in data || "maxTotalTimeout" in data || "ceiling" in data)
  );
}

/** Whether the connection below the protocol really broke, so the session —
 * unlike after a server's own error, including a JSON-RPC response with the
 * same -32000 code the client uses for closure — cannot be trusted for the
 * next call. A missed closure is still caught by the server's next 404. */
function brokeMcpSession(session: ScopedMcpSession, error: unknown): boolean {
  return session.connectionClosed || error instanceof RemoteMcpTransportError;
}
