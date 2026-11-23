import { AsyncLocalStorage } from "node:async_hooks";
import { ipVersion } from "@rakazo/contracts";
import type { Dispatcher } from "undici";
import { Agent, EnvHttpProxyAgent, Pool } from "undici";
import type { ResolvedAddress, ResolveHostname } from "./network-address.js";
import { createAddressCheckedLookup, egressRefused } from "./network-address.js";
import type { ProxyConnectHostPattern } from "./proxy-connect-hosts.js";
import {
  hostMatchesProxyConnectPatterns,
  parseProxyConnectHostPatterns,
} from "./proxy-connect-hosts.js";

/**
 * The request a tunneled CONNECT belongs to. The proxy client is built once per proxy and carries
 * no destination of its own, so the dispatcher records the request here for the moment the CONNECT
 * target is chosen.
 */
type TunnelRequest = { protocol: string; hostname: string };

const tunnelRequest = new AsyncLocalStorage<TunnelRequest>();

/**
 * Honors HTTP(S)_PROXY / NO_PROXY. Direct routes connect through the checked lookup; proxied
 * requests are tunneled with CONNECT to the checked IP, so the proxy never resolves the hostname
 * itself and DNS rebinding cannot reach past it.
 *
 * `RAKAZO_PROXY_CONNECT_BY_HOSTNAME_HOSTS` lists hosts a proxy classifies by name. A listed host
 * is tunneled by hostname only for HTTPS with normal certificate verification, after the same
 * public-address check, and never when the host matches NO_PROXY. Everything else stays pinned
 * to the checked IP. Unset, the list is empty and every tunnel target is the checked IP.
 */
export function createCheckedProxyDispatcher(
  resolve: ResolveHostname,
  validate: (addresses: ResolvedAddress[], hostname: string) => void,
  connectTimeout?: number,
  responseTimeouts?: Pick<Agent.Options, "headersTimeout" | "bodyTimeout">,
): Dispatcher {
  const { env } = process;
  const proxies = [env.http_proxy ?? env.HTTP_PROXY, env.https_proxy ?? env.HTTPS_PROXY];
  for (const proxy of proxies) {
    if (proxy && !/^https?:\/\//i.test(proxy)) throw new Error("Only HTTP proxies are supported");
  }
  // Parsed before the direct-route return so a bad list is refused however the proxy is set.
  const connectByHostname = parseProxyConnectHostPatterns(
    env.RAKAZO_PROXY_CONNECT_BY_HOSTNAME_HOSTS,
  );
  const connect = {
    ...(connectTimeout === undefined ? {} : { timeout: connectTimeout }),
    lookup: createAddressCheckedLookup(resolve, validate),
  };
  if (!proxies.some(Boolean)) return new Agent({ ...responseTimeouts, connect });
  const dispatcher = new EnvHttpProxyAgent({
    ...responseTimeouts,
    connect,
    ...(connectTimeout === undefined ? {} : { connectTimeout }),
    proxyTunnel: true,
    clientFactory: (origin, options) => {
      const pool = new Pool(origin, options);
      const connect = pool.connect.bind(pool) as (
        options: Dispatcher.ConnectOptions,
      ) => Promise<Dispatcher.ConnectData>;
      return Object.assign(pool, {
        connect: async (options: Dispatcher.ConnectOptions) => {
          const authority = await tunnelAuthority(
            tunnelRequest.getStore(),
            options.path,
            resolve,
            validate,
            connectByHostname,
          );
          return connect({
            ...options,
            path: authority,
            headers: { ...(options.headers as Record<string, string>), host: authority },
          });
        },
      });
    },
  });
  if (connectByHostname.length === 0) return dispatcher;
  const dispatch = dispatcher.dispatch.bind(dispatcher);
  return Object.assign(dispatcher, {
    dispatch(options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler) {
      const request = tunnelRequestOf(options.origin);
      if (!request) return dispatch(options, handler);
      return tunnelRequest.run(request, () => dispatch(options, handler));
    },
  });
}

function tunnelRequestOf(origin: string | URL | undefined): TunnelRequest | undefined {
  if (!origin) return undefined;
  try {
    const url = origin instanceof URL ? origin : new URL(origin);
    return { protocol: url.protocol, hostname: url.hostname };
  } catch {
    return undefined;
  }
}

/**
 * The CONNECT target for one request. A listed HTTPS host keeps its name; every other host is
 * rewritten to the address the public-address check accepted.
 */
async function tunnelAuthority(
  request: TunnelRequest | undefined,
  authority: string,
  resolve: ResolveHostname,
  validate: (addresses: ResolvedAddress[], hostname: string) => void,
  connectByHostname: readonly ProxyConnectHostPattern[],
): Promise<string> {
  const separator = authority.lastIndexOf(":");
  const hostname = authority.slice(0, separator).replace(/^\[|\]$/g, "");
  const family = ipVersion(hostname);
  const addresses = family === 0 ? await resolve(hostname) : [{ address: hostname, family }];
  try {
    validate(addresses, hostname);
  } catch (error) {
    throw egressRefused(hostname, error);
  }
  if (connectsByHostname(request, hostname, connectByHostname)) return authority;
  const address = addresses[0]?.address ?? "";
  const host = ipVersion(address) === 6 ? `[${address}]` : address;
  return `${host}${authority.slice(separator)}`;
}

/**
 * Hostname CONNECT is the operator's exception to the address pin, so every condition has to
 * hold: the host is listed, the request is HTTPS, and certificate verification is on. Plain HTTP
 * has no certificate to check, so it stays pinned to the checked address. A NO_PROXY host never
 * reaches this tunnel: the proxy agent routes it to the direct, checked-address route.
 */
function connectsByHostname(
  request: TunnelRequest | undefined,
  hostname: string,
  patterns: readonly ProxyConnectHostPattern[],
): boolean {
  if (!request || patterns.length === 0) return false;
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0") return false;
  if (request.protocol !== "https:") return false;
  if (normalizeHost(request.hostname) !== normalizeHost(hostname)) return false;
  return hostMatchesProxyConnectPatterns(request.hostname, patterns);
}

function normalizeHost(hostname: string): string {
  return hostname
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
}
