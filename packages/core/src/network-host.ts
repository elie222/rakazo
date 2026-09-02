/** Strip IPv6 brackets and lowercase a hostname from a URL. */
export function unbracketedHost(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, "").toLowerCase();
}

function ipv4Octets(host: string): [number, number, number, number] | undefined {
  const parts = host.split(".");
  if (parts.length !== 4) return undefined;
  const octets = parts.map((part) => {
    if (!/^\d{1,3}$/.test(part)) return Number.NaN;
    return Number(part);
  });
  if (octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) {
    return undefined;
  }
  return octets as [number, number, number, number];
}

export function isLoopbackHost(hostname: string): boolean {
  const host = unbracketedHost(hostname);
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "::1") return true;
  const ipv4 = ipv4Octets(host);
  return ipv4?.[0] === 127;
}

/**
 * Link-local addresses (IPv4 169.254/16, IPv6 fe80::/10) often host cloud
 * metadata endpoints. Cleartext HTTP to them is never a legitimate Rakazo origin.
 */
export function isLinkLocalHost(hostname: string): boolean {
  const host = unbracketedHost(hostname);
  const ipv4 = ipv4Octets(host);
  if (ipv4) return ipv4[0] === 169 && ipv4[1] === 254;
  if (!host.includes(":")) return false;
  const first = host.split(":", 1)[0] ?? "";
  return /^fe[89ab]/.test(first);
}

/** Tailscale MagicDNS names. They resolve to CGNAT; the hostname itself is public DNS. */
export function isTailscaleMagicDnsHost(hostname: string): boolean {
  const host = unbracketedHost(hostname).replace(/\.$/, "");
  return host === "ts.net" || host.endsWith(".ts.net");
}

/**
 * Whether a Rakazo client may use cleartext HTTP to this host.
 *
 * Allowed: loopback, RFC1918, CGNAT 100.64/10 (Tailscale and similar overlays),
 * IPv6 unique-local, and *.local. MagicDNS (*.ts.net) requires HTTPS. Link-local
 * is never allowed.
 */
export function allowsCleartextHttp(hostname: string): boolean {
  const host = unbracketedHost(hostname);
  if (isLinkLocalHost(host) || isTailscaleMagicDnsHost(host)) return false;
  if (isLoopbackHost(host) || host.endsWith(".local")) return true;

  const ipv4 = ipv4Octets(host);
  if (ipv4) {
    const [first, second] = ipv4;
    return (
      first === 10 ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168) ||
      (first === 100 && second >= 64 && second <= 127)
    );
  }

  if (!host.includes(":")) return false;
  const first = host.split(":", 1)[0] ?? "";
  return /^f[cd]/.test(first);
}
