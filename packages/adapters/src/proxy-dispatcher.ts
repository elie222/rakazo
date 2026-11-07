import { ipVersion } from "@rakazo/contracts";
import type { Dispatcher } from "undici";
import { EnvHttpProxyAgent, Pool } from "undici";
import type { ResolvedAddress, ResolveHostname } from "./network-address.js";
import { createAddressCheckedLookup, egressRefused } from "./network-address.js";

/**
 * Direct routes (including NO_PROXY) use the checked lookup. Proxy routes re-check the
 * destination before CONNECT and pin it to that address unless the deployment explicitly
 * trusts its proxy to resolve and enforce destination policy itself.
 */
export function createCheckedProxyDispatcher(
  resolve: ResolveHostname,
  validate: (addresses: ResolvedAddress[], hostname: string) => void,
): Dispatcher {
  const { env } = process;
  const connectByHostname = env.RAKAZO_PROXY_CONNECT_BY_HOSTNAME === "true";
  for (const proxy of [env.http_proxy ?? env.HTTP_PROXY, env.https_proxy ?? env.HTTPS_PROXY]) {
    if (proxy && !/^https?:\/\//i.test(proxy)) throw new Error("Only HTTP proxies are supported");
  }
  return new EnvHttpProxyAgent({
    connect: { lookup: createAddressCheckedLookup(resolve, validate) },
    proxyTunnel: true,
    clientFactory: (origin, options) => {
      const pool = new Pool(origin, options);
      const connect = pool.connect.bind(pool) as (
        options: Dispatcher.ConnectOptions,
      ) => Promise<Dispatcher.ConnectData>;
      return Object.assign(pool, {
        connect: async (options: Dispatcher.ConnectOptions) => {
          const separator = options.path.lastIndexOf(":");
          const hostname = options.path.slice(0, separator).replace(/^\[|\]$/g, "");
          const family = ipVersion(hostname);
          const addresses = family ? [{ address: hostname, family }] : await resolve(hostname);
          try {
            validate(addresses, hostname);
          } catch (error) {
            throw egressRefused(hostname, error);
          }
          // Even hostname mode checks locally; only the final DNS pin is delegated to the proxy.
          if (connectByHostname) return connect(options);
          const address = addresses[0]!.address;
          const host = ipVersion(address) === 6 ? `[${address}]` : address;
          const authority = `${host}${options.path.slice(separator)}`;
          return connect({
            ...options,
            path: authority,
            headers: { ...(options.headers as Record<string, string>), host: authority },
          });
        },
      });
    },
  });
}
