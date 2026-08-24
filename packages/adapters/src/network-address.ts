import { isIP, type LookupFunction } from "node:net";

export type ResolvedAddress = { address: string; family: number };
export type ResolveHostname = (hostname: string) => Promise<ResolvedAddress[]>;

export function createAddressCheckedLookup(
  resolve: ResolveHostname,
  validate: (addresses: ResolvedAddress[]) => void,
): LookupFunction {
  return (hostname, options, callback) => {
    void resolve(hostname)
      .then((addresses) => {
        validate(addresses);
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
    if (topTenBits === 0x3fan || topTenBits === 0x3fbn) return true;
    if (((ipv6 >> 120n) & 0xfen) === 0xfcn) return true;
    if (ipv6 >> 32n === 0xffffn) return isPrivateIpv4Number(Number(ipv6 & 0xffffffffn));
    if (ipv6 >> 32n === 0n) return true;
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
