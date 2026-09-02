import {
  allowsCleartextHttp,
  isCgnatHost,
  isLoopbackHost,
  isTailscaleMagicDnsHost,
} from "./network-host.js";

export type ConnectionKind = "loopback" | "lan" | "overlay" | "public";

export function connectionKindForHost(hostname: string): ConnectionKind {
  if (isLoopbackHost(hostname)) return "loopback";
  if (isTailscaleMagicDnsHost(hostname) || isCgnatHost(hostname)) return "overlay";
  if (allowsCleartextHttp(hostname)) return "lan";
  return "public";
}

export function connectionKindLabel(kind: ConnectionKind): string {
  if (kind === "loopback") return "this computer";
  if (kind === "lan") return "local network";
  if (kind === "overlay") return "private overlay";
  return "public";
}

/** Compact origin + scheme + network class for reconnect and server-setup copy. */
export function describeConnectionOrigin(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    const scheme = parsed.protocol === "https:" ? "https" : "http";
    return `${parsed.host} · ${scheme} · ${connectionKindLabel(connectionKindForHost(parsed.hostname))}`;
  } catch {
    return null;
  }
}

export function connectionHintForOrigin(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "http:" && isTailscaleMagicDnsHost(parsed.hostname)) {
      return "MagicDNS needs https://.";
    }
    if (parsed.protocol === "http:" && isCgnatHost(parsed.hostname)) {
      return "Overlay IPs need https://.";
    }
    if (parsed.protocol === "http:" && !allowsCleartextHttp(parsed.hostname)) {
      return "Public servers need https://.";
    }
    if (connectionKindForHost(parsed.hostname) === "overlay") {
      return "Join the same Tailscale or EasyTier network as the server.";
    }
    return null;
  } catch {
    return null;
  }
}
