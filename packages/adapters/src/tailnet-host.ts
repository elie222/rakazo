import { BlockList, isIP } from "node:net";
import type { TailnetDestination } from "@rakazo/contracts";
import { normalizeHost, parseNetworkDestination } from "@rakazo/contracts";
import { TAILNET_CONNECT_TOOL } from "@rakazo/core";
import { requestSite } from "@rakazo/core/egress";

/** 100.64.0.0/10 and fd7a:115c:a1e0::/48, where a tailnet numbers its nodes. */
const PEERS = new BlockList();
PEERS.addSubnet("100.64.0.0", 10, "ipv4");
PEERS.addSubnet("fd7a:115c:a1e0::", 48, "ipv6");
/** The tailnet's own resolver and metadata, which every node answers itself. */
const SERVICES = new BlockList();
SERVICES.addSubnet("100.100.100.0", 24, "ipv4");
SERVICES.addAddress("fd7a:115c:a1e0::53", "ipv6");

/**
 * A tailnet peer's address, without the tailnet's own service addresses. Literal forms only;
 * IPv4-mapped IPv6 and zones are refused.
 */
export function isTailnetAddress(address: string): boolean {
  const value = normalizeHost(address);
  // A zone names an interface on this machine, never a tailnet peer.
  if (value.includes("%")) return false;
  const version = isIP(value);
  if (version === 0) return false;
  const family = version === 4 ? "ipv4" : "ipv6";
  // A mapped address would match the IPv4 range; a tailnet never numbers a peer that way.
  if (family === "ipv6" && value.includes(".")) return false;
  return PEERS.check(value, family) && !SERVICES.check(value, family);
}

/**
 * A host a tailnet connection may dial: a tailnet address or a MagicDNS name under `ts.net`.
 * Short names and other suffixes are refused, so a name can never fall back to public DNS.
 */
export function isTailnetHost(hostname: string): boolean {
  const host = normalizeHost(hostname);
  if (isIP(host) !== 0) return isTailnetAddress(host);
  if (!host.endsWith(".ts.net")) return false;
  const labels = host.slice(0, -".ts.net".length).split(".");
  // At least a machine and a tailnet label, each a valid DNS label.
  return (
    labels.length >= 2 &&
    labels.every((label) => /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  );
}

/** A normalized tailnet destination, or undefined when the host or port is not one. */
export function parseTailnetDestination(
  host: string,
  port: number | string,
): TailnetDestination | undefined {
  const destination = parseNetworkDestination(host, port);
  return destination && isTailnetHost(destination.host) ? destination : undefined;
}

/**
 * The `host:port` a tailnet_connect call asks for, or undefined when it is not on a tailnet. The
 * key is the one approvals are stored under (`requestSite`); this only adds the tailnet check.
 */
export function tailnetConnectSite(request: unknown): string | undefined {
  const site = requestSite(TAILNET_CONNECT_TOOL, request);
  if (!site) return undefined;
  const host = site.slice(0, site.lastIndexOf(":")).replace(/^\[|\]$/g, "");
  return isTailnetHost(host) ? site : undefined;
}
