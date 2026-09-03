import { lookup } from "node:dns/promises";
import { isIP, type LookupFunction } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ConnectorTool } from "@rakazo/adapter-kit";
import { Agent } from "undici";
import { combineSignals } from "./connector-safety.js";
import {
  createAddressCheckedLookup,
  isPrivateAddress,
  type ResolvedAddress,
  type ResolveHostname,
} from "./network-address.js";

const MAX_MCP_TOOLS = 250;
const MAX_MCP_PAGES = 20;
const MCP_TIMEOUT_MS = 30_000;
const MAX_RESULT_BYTES = 1_000_000;

export type { ResolveHostname } from "./network-address.js";

export interface RemoteTransportDependencies {
  fetch?: typeof globalThis.fetch;
  resolveHostname?: ResolveHostname;
}

export interface RemoteMcpOptions extends RemoteTransportDependencies {
  endpoint: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

export interface SafeRemoteFetch {
  (input: string | URL | Request, init?: RequestInit): Promise<Response>;
  close(): Promise<void>;
}

const resolveHostname: ResolveHostname = (hostname) =>
  lookup(hostname, { all: true, verbatim: true });

export async function listRemoteMcpTools(options: RemoteMcpOptions): Promise<ConnectorTool[]> {
  return withRemoteMcpClient(options, async (client, signal) => {
    const tools: ConnectorTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_MCP_PAGES && tools.length < MAX_MCP_TOOLS; page += 1) {
      const result = await client.listTools(cursor ? { cursor } : undefined, {
        signal,
        timeout: MCP_TIMEOUT_MS,
      });
      for (const tool of result.tools) {
        if (tools.length >= MAX_MCP_TOOLS) break;
        tools.push({
          name: tool.name,
          description: tool.description ?? tool.title ?? tool.name,
          inputSchema: tool.inputSchema,
          readOnly: tool.annotations?.readOnlyHint,
        });
      }
      cursor = result.nextCursor;
      if (!cursor) break;
    }
    return tools;
  });
}

export async function callRemoteMcpTool(
  options: RemoteMcpOptions,
  toolName: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  return withRemoteMcpClient(options, async (client, signal) => {
    const result = await client.callTool({ name: toolName, arguments: args }, undefined, {
      signal,
      timeout: MCP_TIMEOUT_MS,
    });
    return limitPayload({
      content: result.content,
      structuredContent: result.structuredContent,
      isError: result.isError ?? false,
      _meta: result._meta,
    });
  });
}

async function withRemoteMcpClient<T>(
  options: RemoteMcpOptions,
  run: (client: Client, signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const endpoint = await assertSafeRemoteUrl(
    options.endpoint,
    options.resolveHostname ?? resolveHostname,
  );
  const signal = combineSignals(options.signal, AbortSignal.timeout(MCP_TIMEOUT_MS));
  const safeFetch = createSafeRemoteFetch(
    options.fetch ?? globalThis.fetch,
    options.resolveHostname ?? resolveHostname,
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
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Connector URL is invalid");
  }
  if (url.protocol !== "https:") throw new Error("Connector URL must use HTTPS");
  if (url.username || url.password) throw new Error("Connector URL must not contain credentials");
  if (url.hash) throw new Error("Connector URL must not contain a fragment");
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (isPrivateHostname(hostname)) throw new Error("Connector URL targets a private host");
  assertPublicAddresses(await resolve(hostname), hostname);
  return url;
}

export function createSafeRemoteFetch(
  baseFetch: typeof globalThis.fetch = globalThis.fetch,
  resolve: ResolveHostname = resolveHostname,
): SafeRemoteFetch {
  const dispatcher = new Agent({ connect: { lookup: createSafeLookup(resolve) } });
  const safeFetch = async (input: string | URL | Request, init?: RequestInit) => {
    if (typeof input !== "string" && !(input instanceof URL)) {
      throw new Error("Connector fetch requires a URL, not a Request");
    }
    const url = await assertSafeRemoteUrl(String(input), resolve);
    const response = await baseFetch(url, {
      ...init,
      redirect: "manual",
      dispatcher,
    } as RequestInit & { dispatcher: Agent });
    if (response.status >= 300 && response.status < 400) {
      throw new Error("Connector redirects are not allowed");
    }
    return response;
  };
  const result = safeFetch as SafeRemoteFetch;
  result.close = () => dispatcher.close();
  return result;
}

export function createSafeLookup(resolve: ResolveHostname = resolveHostname): LookupFunction {
  return createAddressCheckedLookup(resolve, assertPublicAddresses);
}

/** Tailscale MagicDNS names (*.ts.net) are public DNS names, not private IP literals. */
function isTailscaleMagicDnsHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/, "");
  return normalized === "ts.net" || normalized.endsWith(".ts.net");
}

/** Tailscale assigns CGNAT 100.64.0.0/10; MagicDNS may resolve there. */
function isTailscaleCgnatAddress(address: string): boolean {
  const value = address.toLowerCase().replace(/^\[|\]$/g, "");
  const mapped = value.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  const ipv4 = mapped ?? (isIP(value) === 4 ? value : undefined);
  if (!ipv4) return false;
  const [a, b] = ipv4.split(".").map(Number);
  return a === 100 && b != null && b >= 64 && b <= 127;
}

function isPrivateHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/, "");
  if (isTailscaleMagicDnsHostname(normalized)) return false;
  return (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local") ||
    normalized.endsWith(".internal") ||
    normalized === "metadata.google.internal" ||
    (isIP(normalized) !== 0 && isPrivateAddress(normalized))
  );
}

function assertPublicAddresses(addresses: ResolvedAddress[], hostname?: string): void {
  if (addresses.length === 0) {
    throw new Error("Connector URL resolves to a private address");
  }
  const magicDns = hostname != null && isTailscaleMagicDnsHostname(hostname);
  if (
    addresses.some((entry) => {
      if (!isPrivateAddress(entry.address)) return false;
      // Allow only Tailscale CGNAT for MagicDNS; keep other private ranges blocked.
      return !(magicDns && isTailscaleCgnatAddress(entry.address));
    })
  ) {
    throw new Error("Connector URL resolves to a private address");
  }
}

function limitPayload(value: unknown): unknown {
  const serialized = JSON.stringify(value);
  if (serialized.length <= MAX_RESULT_BYTES) return value;
  return {
    truncated: true,
    content: serialized.slice(0, MAX_RESULT_BYTES),
  };
}
