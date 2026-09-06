import { isIP, type LookupFunction } from "node:net";

export type ResolvedAddress = { address: string; family: number };
export type ResolveHostname = (hostname: string) => Promise<ResolvedAddress[]>;

const CLOUD_METADATA_IPV4 = new Set([
  ipv4ToNumber("169.254.169.254"),
  ipv4ToNumber("100.100.100.200"),
]);
const AWS_IMDS_IPV6 = 0xfd000ec2000000000000000000000254n;

export function createAddressCheckedLookup(
  resolve: ResolveHostname,
  validate: (addresses: ResolvedAddress[], hostname: string) => void,
): LookupFunction {
  return (hostname, options, callback) => {
    void resolve(hostname)
      .then((addresses) => {
        validate(addresses, hostname);
        if (options.all) {
          callback(null, addresses);
          return;
        }
        const requestedFamily = typeof options.family === "number" ? options.family : 0;
        const selected =
          addresses.find((entry) => requestedFamily === 0 || entry.family === requestedFamily) ??
          addresses[0];
        if (!selected) throw new Error("Endpoint did not resolve to an address");
        callback(null, selected.address, selected.family);
      })
      .catch((error: unknown) =>
        callback(error instanceof Error ? error : new Error(String(error)), "", 0),
      );
  };
}

export function isPrivateAddress(address: string): boolean {
  const value = address.toLowerCase().replace(/^\[|\]$/g, "");
  const mapped = value.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  const ipv4 = mapped ?? (isIP(value) === 4 ? value : undefined);
  if (!ipv4) {
    const ipv6 = parseIpv6(value);
    if (ipv6 === undefined) return true;
    if (ipv6 === 0n || ipv6 === 1n) return true;
    if (ipv6 >> 120n === 0xffn) return true;
    const topTenBits = ipv6 >> 118n;
    // fe80::/10 link-local (and the adjacent fea0::/10 bit pattern 0x3fb)
    if (topTenBits === 0x3fan || topTenBits === 0x3fbn) return true;
    // fc00::/7 unique local (ULA), including fd00::/8
    if (((ipv6 >> 120n) & 0xfen) === 0xfcn) return true;
    const embeddedIpv4 = getEmbeddedIpv4Number(ipv6);
    if (embeddedIpv4 !== undefined) return isPrivateIpv4Number(embeddedIpv4);
    return false;
  }
  const octets = ipv4.split(".").map(Number);
  const [a, b] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b != null && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b != null && b >= 64 && b <= 127) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a != null && a >= 224)
  );
}

export function isCloudMetadataAddress(address: string): boolean {
  const value = address.toLowerCase().replace(/^\[|\]$/g, "");
  const mapped = value.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  const ipv4 = mapped ?? (isIP(value) === 4 ? value : undefined);
  if (ipv4) return isCloudMetadataIpv4Number(ipv4ToNumber(ipv4));

  const ipv6 = parseIpv6(value);
  if (ipv6 === undefined) return false;
  if (ipv6 === AWS_IMDS_IPV6) return true;
  const embeddedIpv4 = getEmbeddedIpv4Number(ipv6);
  return embeddedIpv4 !== undefined && isCloudMetadataIpv4Number(embeddedIpv4);
}

export function isLinkLocalAddress(address: string): boolean {
  const value = address.toLowerCase().replace(/^\[|\]$/g, "");
  const mapped = value.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  const ipv4 = mapped ?? (isIP(value) === 4 ? value : undefined);
  if (ipv4) {
    const [a, b] = ipv4.split(".").map(Number);
    return a === 169 && b === 254;
  }

  const ipv6 = parseIpv6(value);
  if (ipv6 === undefined) return false;
  const ipv4Prefix = ipv6 >> 32n;
  if (ipv4Prefix === 0xffffn || ipv4Prefix === 0n) {
    const embeddedIpv4 = Number(ipv6 & 0xffffffffn);
    return ((embeddedIpv4 >>> 24) & 0xff) === 169 && ((embeddedIpv4 >>> 16) & 0xff) === 254;
  }
  return ipv6 >> 118n === 0x3fan;
}

function parseIpv6(value: string): bigint | undefined {
  if (isIP(value) !== 6) return undefined;
  const dottedTail = value.slice(value.lastIndexOf(":") + 1);
  const normalized = dottedTail.includes(".") ? replaceIpv4Tail(value, dottedTail) : value;
  if (!normalized) return undefined;
  const [leftValue, rightValue] = normalized.split("::", 2);
  const left = leftValue ? leftValue.split(":") : [];
  const right = rightValue ? rightValue.split(":") : [];
  const missing = 8 - left.length - right.length;
  if (!value.includes("::") && missing !== 0) return undefined;
  const groups = [...left, ...Array.from({ length: missing }, () => "0"), ...right];
  if (groups.length !== 8) return undefined;
  try {
    return groups.reduce((result, group) => (result << 16n) | BigInt(`0x${group || "0"}`), 0n);
  } catch {
    return undefined;
  }
}

function replaceIpv4Tail(value: string, tail: string): string | undefined {
  if (isIP(tail) !== 4) return undefined;
  const [a, b, c, d] = tail.split(".").map(Number);
  if (a == null || b == null || c == null || d == null) return undefined;
  const first = ((a << 8) | b).toString(16);
  const second = ((c << 8) | d).toString(16);
  return `${value.slice(0, value.lastIndexOf(":") + 1)}${first}:${second}`;
}

function ipv4ToNumber(value: string): number {
  return value.split(".").reduce((result, octet) => (result << 8) | Number(octet), 0) >>> 0;
}

function getEmbeddedIpv4Number(ipv6: bigint): number | undefined {
  const ipv4Prefix = ipv6 >> 32n;
  // ::ffff:0:0/96 IPv4-mapped and ::/96 IPv4-compatible (deprecated).
  if (ipv4Prefix === 0xffffn || ipv4Prefix === 0n) return Number(ipv6 & 0xffffffffn);
  // 64:ff9b::/96 NAT64 well-known prefix.
  if (ipv4Prefix === 0x64ff9bn << 64n) return Number(ipv6 & 0xffffffffn);
  // 2002::/16 6to4 — IPv4 lives in the next 32 bits after the prefix.
  if (ipv6 >> 112n === 0x2002n) return Number((ipv6 >> 80n) & 0xffffffffn);
  return undefined;
}

function isCloudMetadataIpv4Number(value: number): boolean {
  return CLOUD_METADATA_IPV4.has(value);
}

function isPrivateIpv4Number(value: number): boolean {
  const a = (value >>> 24) & 0xff;
  const b = (value >>> 16) & 0xff;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}
