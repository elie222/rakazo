import { lookup } from "node:dns/promises";
import type { LookupFunction } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ConnectorTool } from "@rakazo/adapter-kit";
import {
  ipVersion,
  isCloudMetadataAddress,
  isCloudMetadataHost,
  isInternalHostname,
  isLinkLocalAddress,
  isLocalhostOrLoopbackIp,
  isLoopbackAddress,
  isNonPublicAddress,
  normalizeHost,
} from "@rakazo/contracts";
import { Agent } from "undici";
import { composioToolBatch } from "./composio-batch.js";
import { combineSignals } from "./connector-safety.js";
import type { ResolvedAddress, ResolveHostname } from "./network-address.js";
import {
  createAddressCheckedLookup,
  egressRefused,
  withPinnedDnsLookup,
} from "./network-address.js";
import { dispatcherFetch, fetchPairedWithDispatcher } from "./undici-fetch.js";

const MAX_MCP_TOOLS = 250;
const MAX_MCP_PAGES = 20;
const MCP_TIMEOUT_MS = 30_000;
const MAX_RESULT_BYTES = 1_000_000;

export type { ResolveHostname } from "./network-address.js";

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

export async function listRemoteMcpTools(options: RemoteMcpOptions): Promise<ConnectorTool[]> {
  return withRemoteMcpClient(options, async (client, signal) =>
    (await listMcpTools(client, { signal, timeout: MCP_TIMEOUT_MS })).map((tool) => ({
      name: tool.name,
      description: tool.description ?? tool.title ?? tool.name,
      inputSchema: tool.inputSchema,
      readOnly: tool.annotations?.readOnlyHint,
      batch: composioToolBatch(tool.name),
    })),
  );
}

/** Follow `tools/list` cursors, bounded by the shared page and tool caps. */
export async function listMcpTools(client: Client, options: RequestOptions): Promise<Tool[]> {
  const tools: Tool[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_MCP_PAGES && tools.length < MAX_MCP_TOOLS; page += 1) {
    const result = await client.listTools(cursor ? { cursor } : undefined, options);
    tools.push(...result.tools.slice(0, MAX_MCP_TOOLS - tools.length));
    cursor = result.nextCursor;
    if (!cursor) break;
  }
  return tools;
}

/** Call through the guarded transport, optionally projecting before the final byte limit. */
export async function callRemoteMcpTool(
  options: RemoteMcpOptions,
  toolName: string,
  args: Record<string, unknown>,
  projectResult?: (result: unknown) => unknown,
): Promise<unknown> {
  return withRemoteMcpClient(options, async (client, signal) => {
    const result = await client.callTool({ name: toolName, arguments: args }, undefined, {
      signal,
      timeout: MCP_TIMEOUT_MS,
    });
    const envelope = {
      content: result.content,
      structuredContent: result.structuredContent,
      isError: result.isError ?? false,
      _meta: result._meta,
    };
    // Providers may extract a bounded domain result before duplicate MCP text
    // and structured content consume the budget. The final limit still applies.
    return limitRemoteMcpPayload(projectResult ? projectResult(envelope) : envelope);
  });
}

async function withRemoteMcpClient<T>(
  options: RemoteMcpOptions,
  run: (client: Client, signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const policy = { allowPrivateEndpoint: options.allowPrivateEndpoint };
  const endpoint = await assertSafeRemoteUrl(
    options.endpoint,
    options.resolveHostname ?? resolveHostname,
    policy,
  );
  const signal = combineSignals(options.signal, AbortSignal.timeout(MCP_TIMEOUT_MS));
  const safeFetch = createSafeRemoteFetch(
    options.fetch,
    options.resolveHostname ?? resolveHostname,
    policy,
  );
  const transport = new StreamableHTTPClientTransport(endpoint, {
    requestInit: {
      headers: options.headers,
      redirect: "manual",
      signal,
    },
    fetch: safeFetch,
  });
  const client = new Client({ name: "rakazo", version: "0.1.0" }, { capabilities: {} });
  try {
    await client.connect(transport, { signal, timeout: MCP_TIMEOUT_MS });
    return await run(client, signal);
  } finally {
    await client.close().catch(() => undefined);
    await safeFetch.close().catch(() => undefined);
  }
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
    throw new Error("Connector URL is invalid");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Connector URL must use HTTPS");
  }
  if (url.username || url.password) throw new Error("Connector URL must not contain credentials");
  if (url.hash) throw new Error("Connector URL must not contain a fragment");
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (isCloudMetadataHost(hostname))
    throw egressRefused(hostname, new Error("Connector URL targets a private host"));
  // Loopback is a private endpoint too: only the private-endpoint escape reaches it.
  const allowPrivate = policy.allowPrivateEndpoint === true;
  const privateHost = isPrivateRemoteMcpHostname(hostname);
  if (url.protocol === "http:" && !allowPrivate) {
    throw new Error("Connector URL must use HTTPS");
  }
  if (privateHost && !allowPrivate) {
    throw egressRefused(hostname, new Error("Connector URL targets a private host"));
  }
  const literal = literalAddresses(hostname);
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
    throw new Error("Connector URL must use HTTPS");
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
): SafeRemoteFetch {
  const dispatcher = new Agent({ connect: { lookup: createSafeLookup(resolve, policy) } });
  // Injected fetches are not given this Agent; they keep the original hostname
  // for TLS/SNI and pin TCP to the already-validated address through dns.lookup.
  const usePackageFetch = fetchPairedWithDispatcher(baseFetch) === dispatcherFetch;
  const safeFetch = async (input: string | URL | Request, init?: RequestInit) => {
    if (typeof input !== "string" && !(input instanceof URL)) {
      throw new Error("Connector fetch requires a URL, not a Request");
    }
    const { url, addresses } = await inspectSafeRemoteUrl(String(input), resolve, policy);
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
      const detail = transportFailureDetail(error);
      throw new Error(`Could not reach ${url.host}${detail ? `: ${detail}` : ""}`, {
        cause: error,
      });
    }
    if (response.status >= 300 && response.status < 400) {
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
      const detail = transportFailureDetail(error);
      throw new Error(`Could not reach ${url.host}${detail ? `: ${detail}` : ""}`, {
        cause: error,
      });
    }
    if (response.status >= 300 && response.status < 400) {
      throw new Error("Private fetch redirects are not allowed");
    }
    return response;
  };
  const result = privateFetch as SafeRemoteFetch;
  result.close = () => dispatcher.close();
  return result;
}

const MAX_CAUSE_DEPTH = 5;

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
  return createAddressCheckedLookup(resolve, (addresses, hostname) => {
    if (
      policy.allowPrivateEndpoint === true &&
      isLocalhostOrLoopbackIp(hostname.replace(/^\[|\]$/g, ""))
    ) {
      assertLoopbackAddresses(addresses);
      return;
    }
    assertAllowedAddresses(addresses, policy);
  });
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
    throw new Error("Connector URL resolves to a private address");
  }
}

function assertAllowedAddresses(addresses: ResolvedAddress[], policy: RemoteUrlPolicy): void {
  if (policy.allowPrivateEndpoint === true) {
    assertUnmixedAddresses(addresses);
    return;
  }
  assertPublicAddresses(addresses);
}

function assertUnmixedAddresses(addresses: ResolvedAddress[]): void {
  if (addresses.length === 0) {
    throw new Error("Connector URL resolves to a private address");
  }
  // Link-local stays blocked: that range holds cloud metadata, same as private credential fetches.
  if (
    addresses.some(
      (entry) => isCloudMetadataAddress(entry.address) || isLinkLocalAddress(entry.address),
    )
  ) {
    throw new Error("Connector URL resolves to a private address");
  }
  const hasPrivate = addresses.some((entry) => isNonPublicAddress(entry.address));
  const hasPublic = addresses.some((entry) => !isNonPublicAddress(entry.address));
  if (hasPrivate && hasPublic) {
    throw new Error("Connector URL resolves to a private address");
  }
}

/** Tailnet (*.ts.net) answers are private addresses too, so they need the private-endpoint escape. */
function assertPublicAddresses(addresses: ResolvedAddress[]): void {
  if (addresses.length === 0) {
    throw new Error("Connector URL resolves to a private address");
  }
  if (
    addresses.some(
      (entry) => isCloudMetadataAddress(entry.address) || isNonPublicAddress(entry.address),
    )
  ) {
    throw new Error("Connector URL resolves to a private address");
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
