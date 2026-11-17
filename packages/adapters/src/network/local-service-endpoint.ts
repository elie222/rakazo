import { lookup } from "node:dns/promises";
import {
  ipVersion,
  isCloudMetadataAddress,
  isCloudMetadataHost,
  isLinkLocalAddress,
  isLocalhostOrLoopbackIp,
  isNonPublicAddress,
  normalizeHost,
} from "@rakazo/contracts";
import type { SafeRemoteFetch } from "../mcp/remote-mcp.js";
import {
  createPrivateNetworkFetch,
  createSafeRemoteFetch,
  isPrivateRemoteMcpHostname,
} from "../mcp/remote-mcp.js";
import { MemoryProviderPrivateEndpointRequiredError } from "../providers/memory/serenity/serenity-memory-provider.js";
import { withAbort } from "../web/web-ssrf.js";
import type { ResolvedAddress, ResolveHostname } from "./network-address.js";
import { egressRefused } from "./network-address.js";

/**
 * Self-hosted ("local") memory services. Hostnames are resolved once, classified by the
 * addresses they resolve to, and pinned to those addresses for requests. A server on public
 * addresses works like any public HTTPS service; one on loopback or a private network needs the
 * operator's private-endpoint setting.
 */

const LOCAL_NETWORK_ERROR = "Local mode requires a loopback or private-network address.";
const PUBLIC_NETWORK_ERROR = "Memory base URL no longer resolves to a public address.";
const PUBLIC_HTTPS_ERROR = "A public memory base URL must use HTTPS.";
const UNRESOLVED_ERROR = "Memory base URL did not resolve to an address.";
const BLOCKED_TARGET_ERROR = "Local mode cannot target a blocked address.";
const LOCAL_DNS_TIMEOUT_MS = 10_000;

/** Where a self-hosted server was found when its connection was checked. */
export type LocalServiceTrust = "public" | "private";

/** The checked trust and, for a hostname, the addresses requests are pinned to. */
export interface LocalServicePin {
  trust: LocalServiceTrust;
  pinnedAddresses?: ResolvedAddress[];
}

export interface LocalServiceConnection {
  baseUrl: string;
  /** Test seam. Production resolves DNS and pins the checked answers. */
  resolveHostname?: ResolveHostname;
  /** Public servers take the public-only transport. Anything else is treated as private. */
  trust?: LocalServiceTrust;
  /**
   * Addresses already accepted for this host. The transport checks them again at request
   * time and does not resolve the name.
   */
  pinnedAddresses?: ResolvedAddress[];
  /** Test seam. Production uses the runtime fetch paired with the pinned dispatcher. */
  fetch?: typeof globalThis.fetch;
}

const defaultResolveHostname: ResolveHostname = (hostname) =>
  lookup(hostname, { all: true, verbatim: true });

/** Base URLs are route prefixes, never credentials or request query/fragment state. */
export function parseServiceBaseUrl(baseUrl: string): URL {
  const url = new URL(baseUrl);
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    // search/hash are empty for a bare ?/#, but those delimiters still swallow appended routes.
    url.href.includes("?") ||
    url.href.includes("#")
  ) {
    throw new Error(
      "Memory base URL must use HTTP(S) without credentials, a query, or a fragment.",
    );
  }
  return url;
}

function hostnameOf(url: URL): string {
  return normalizeHost(url.hostname);
}

function isAlwaysBlockedAddress(address: string): boolean {
  return isCloudMetadataAddress(address) || isLinkLocalAddress(address);
}

/** Saved settings: only a server confirmed public is saved as public; older saves stay private. */
export function localServiceTrust(settings: Record<string, string>): LocalServiceTrust {
  return settings.endpointTrust === "public" ? "public" : "private";
}

/** The settings a checked connection saves so later requests keep the same trust. */
export function localServiceTrustSettings(pin?: LocalServicePin): Record<string, string> {
  return pin?.trust === "public" ? { endpointTrust: "public" } : {};
}

/** Metadata names and link-local literals. Everything else is classified by its addresses. */
export function assertLocalServiceBaseUrlSync(baseUrl: string): void {
  const host = hostnameOf(parseServiceBaseUrl(baseUrl));
  if (isCloudMetadataHost(host) || (ipVersion(host) !== 0 && isLinkLocalAddress(host))) {
    throw egressRefused(host, new Error(BLOCKED_TARGET_ERROR));
  }
}

async function resolveAddresses(
  host: string,
  resolve: ResolveHostname,
  signal: AbortSignal | undefined,
): Promise<ResolvedAddress[]> {
  let addresses: ResolvedAddress[];
  try {
    addresses = await withAbort(resolve(host), signal ?? AbortSignal.timeout(LOCAL_DNS_TIMEOUT_MS));
  } catch {
    throw new Error(UNRESOLVED_ERROR);
  }
  if (addresses.length === 0) throw new Error(UNRESOLVED_ERROR);
  return addresses.map((entry) => ({ address: entry.address, family: entry.family }));
}

/**
 * Classifies by the resolved addresses, never the name alone: a public-looking name that
 * resolves to a private address is private. Reserved local names stay private whatever they
 * resolve to, and a mix of public and private answers is refused. Public hosts need HTTPS, as
 * remote connectors do.
 */
async function classifyLocalServiceHost(
  baseUrl: string,
  options: { resolveHostname?: ResolveHostname; signal?: AbortSignal },
): Promise<LocalServicePin> {
  assertLocalServiceBaseUrlSync(baseUrl);
  const url = parseServiceBaseUrl(baseUrl);
  const host = hostnameOf(url);
  if (isLocalhostOrLoopbackIp(host)) return { trust: "private" };
  const family = ipVersion(host);
  const addresses =
    family !== 0
      ? [{ address: host, family }]
      : await resolveAddresses(
          host,
          options.resolveHostname ?? defaultResolveHostname,
          options.signal,
        );
  if (addresses.some((entry) => isAlwaysBlockedAddress(entry.address))) {
    throw egressRefused(host, new Error(BLOCKED_TARGET_ERROR));
  }
  // IP literals have no DNS to rebind.
  const pinned = family === 0 ? { pinnedAddresses: addresses } : {};
  if (
    !isPrivateRemoteMcpHostname(host) &&
    addresses.every((entry) => !isNonPublicAddress(entry.address))
  ) {
    if (url.protocol !== "https:") throw new Error(PUBLIC_HTTPS_ERROR);
    return { trust: "public", ...pinned };
  }
  if (addresses.some((entry) => !isNonPublicAddress(entry.address))) {
    throw egressRefused(host, new Error(LOCAL_NETWORK_ERROR));
  }
  return { trust: "private", ...pinned };
}

/**
 * Checks a self-hosted host and returns how to reach it. Loopback and private hosts require
 * operator authorization; public hosts do not. With `trust`, the host must still classify the
 * way it did when the connection was saved.
 */
export async function pinLocalServiceHost(
  baseUrl: string,
  options: {
    allowPrivateEndpoint?: boolean;
    resolveHostname?: ResolveHostname;
    signal?: AbortSignal;
    trust?: LocalServiceTrust;
  } = {},
): Promise<LocalServicePin> {
  const pin = await classifyLocalServiceHost(baseUrl, options);
  const host = hostnameOf(parseServiceBaseUrl(baseUrl));
  if (options.trust && pin.trust !== options.trust) {
    throw egressRefused(
      host,
      new Error(options.trust === "public" ? PUBLIC_NETWORK_ERROR : LOCAL_NETWORK_ERROR),
    );
  }
  if (pin.trust === "private" && options.allowPrivateEndpoint !== true) {
    throw egressRefused(host, new MemoryProviderPrivateEndpointRequiredError());
  }
  return pin;
}

/**
 * Marks a self-hosted connection public when its host resolves only to public addresses,
 * without sending it anything. Callers enforce the private-endpoint setting on the result.
 */
export async function classifyLocalServiceSettings(
  settings: Record<string, string>,
): Promise<Record<string, string>> {
  const classified = { ...settings };
  delete classified.endpointTrust;
  if (settings.mode !== "local" || !settings.baseUrl?.trim()) return classified;
  const pin = await classifyLocalServiceHost(settings.baseUrl.trim(), {});
  return { ...classified, ...localServiceTrustSettings(pin) };
}

/** Recheck a persisted self-hosted endpoint before its credentials are decrypted. */
export async function revalidateLocalServiceSettings(
  settings: Record<string, string>,
): Promise<void> {
  if (settings.mode !== "local") return;
  if (!settings.baseUrl) throw new Error("baseUrl is required");
  // Private connections reach here only once the caller checked the operator setting.
  await pinLocalServiceHost(settings.baseUrl, {
    allowPrivateEndpoint: true,
    trust: localServiceTrust(settings),
  });
}

/** Loopback and IP literals have no DNS to rebind. Private names pin to private addresses. */
function pinsPrivateDns(baseUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return false;
  }
  const host = hostnameOf(url);
  return !isLocalhostOrLoopbackIp(host) && ipVersion(host) === 0;
}

function resolverFor(connection: LocalServiceConnection): ResolveHostname {
  if (!connection.pinnedAddresses) return connection.resolveHostname ?? defaultResolveHostname;
  const addresses = connection.pinnedAddresses;
  return async () => addresses;
}

/**
 * Fetch a self-hosted service. Public servers go through the public-only transport; private
 * hostnames are pinned to their checked private addresses.
 */
export async function fetchLocalService(
  connection: LocalServiceConnection,
  url: string,
  init: RequestInit,
): Promise<Response> {
  const transport = connection.fetch ?? fetch;
  let safe: SafeRemoteFetch;
  if (connection.trust === "public") {
    safe = createSafeRemoteFetch(transport, resolverFor(connection));
  } else if (pinsPrivateDns(connection.baseUrl)) {
    safe = createPrivateNetworkFetch(transport, resolverFor(connection));
  } else {
    return transport(url, init);
  }
  try {
    const response = await safe(url, init);
    // Closing the pinned dispatcher waits until its response body settles.
    // Hand the body to the caller first, and close when they read or cancel it.
    return releaseTransportWithBody(response, () => safe.close());
  } catch (error) {
    await safe.close().catch(() => undefined);
    throw error;
  }
}

function releaseTransportWithBody(response: Response, close: () => Promise<void>): Response {
  let closed = false;
  const release = () => {
    if (closed) return;
    closed = true;
    void close().catch(() => undefined);
  };
  if (!response.body) {
    release();
    return response;
  }
  const reader = response.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await reader.read();
        if (result.done) {
          controller.close();
          release();
          return;
        }
        controller.enqueue(result.value);
      } catch (error) {
        release();
        controller.error(error);
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        release();
      }
    },
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/** Checks a provider's local host once, then reuses its pinned addresses for every request. */
export class LocalServiceHost {
  private pinnedAddresses?: ResolvedAddress[];
  private hostReady = false;
  private pinTask?: Promise<void>;

  constructor(
    private readonly baseUrl: string,
    /** The trust the connection was saved with; the host must still classify the same way. */
    private readonly trust: LocalServiceTrust,
    private readonly resolveHostname?: ResolveHostname,
  ) {}

  /** Returns why the host is unusable, or null once it has been checked. */
  async block(signal?: AbortSignal): Promise<string | null> {
    // One successful check per provider. Repeating it would let a DNS blip block
    // a host this provider already reached, and multi-request recall would redo it.
    if (this.hostReady) return null;
    this.pinTask ??= this.resolvePin();
    try {
      await withAbort(this.pinTask, signal);
      this.hostReady = true;
      return null;
    } catch (error) {
      // Caller cancellation must not discard a still-bounded pin shared by other requests.
      if (!signal?.aborted) this.pinTask = undefined;
      return error instanceof Error ? error.message : BLOCKED_TARGET_ERROR;
    }
  }

  private async resolvePin(): Promise<void> {
    // Private connections are created only once the caller checked the operator setting.
    const pin = await pinLocalServiceHost(this.baseUrl, {
      allowPrivateEndpoint: true,
      trust: this.trust,
      resolveHostname: this.resolveHostname,
    });
    this.pinnedAddresses = pin.pinnedAddresses;
  }

  withPin<T extends LocalServiceConnection>(connection: T): T {
    return {
      ...connection,
      trust: this.trust,
      ...(this.pinnedAddresses ? { pinnedAddresses: this.pinnedAddresses } : {}),
    };
  }
}
