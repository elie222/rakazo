import { domainToASCII } from "node:url";
import { ipVersion } from "@rakazo/contracts";
import { isPublicSuffix } from "@rakazo/core/egress";

/**
 * Hosts an operator lists in `RAKAZO_PROXY_CONNECT_BY_HOSTNAME_HOSTS`. A listed host may be sent
 * to the proxy by name instead of by the address that was checked. Unset means no host is listed,
 * which is the default and leaves the checked-address tunnel unchanged.
 */
export type ProxyConnectHostPattern = { wildcard: boolean; hostname: string };

const ENV_NAME = "RAKAZO_PROXY_CONNECT_BY_HOSTNAME_HOSTS";

const ENTRY = /^[a-z0-9\u0080-\uffff.-]+$/;
const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

/**
 * The ASCII form a request host carries. `domainToASCII` lowercases, converts an internationalized
 * name to punycode and drops what follows a slash, so the entry is checked for characters a host
 * cannot hold before it runs, and every label again after.
 */
function asciiHostname(value: string): string | undefined {
  if (!ENTRY.test(value)) return undefined;
  const ascii = domainToASCII(value);
  if (!ascii || ascii.length > 253) return undefined;
  return ascii.split(".").every((label) => LABEL.test(label)) ? ascii : undefined;
}

/**
 * Parse the operator's list. An empty or unset value lists nothing. A bare `*` and a pattern that
 * is only a public suffix (`*.com`, `*.co.uk`) are refused: either one would drop the address pin
 * for names the operator did not choose.
 *
 * Every entry ends up in the ASCII form a request host carries, so an internationalized name the
 * operator writes matches the punycode hostname a fetch is dispatched with. An entry that cannot
 * be a hostname (`example.com:443`, a URL, a path) is refused rather than accepted and silently
 * never matched.
 */
export function parseProxyConnectHostPatterns(
  value: string | undefined,
): ProxyConnectHostPattern[] {
  if (value == null || value.trim() === "") return [];
  const patterns: ProxyConnectHostPattern[] = [];
  for (const raw of value.split(",")) {
    const entry = raw.trim().toLowerCase().replace(/\.$/, "");
    if (!entry) continue;
    if (entry === "*") {
      throw new Error(`${ENV_NAME} rejects "*": list the hosts to tunnel by name`);
    }
    const wildcard = entry.startsWith("*.");
    const hostname = asciiHostname((wildcard ? entry.slice(2) : entry).replace(/\.$/, ""));
    if (!hostname || ipVersion(hostname)) {
      throw new Error(`${ENV_NAME} has an invalid host pattern "${raw.trim()}"`);
    }
    if (isPublicSuffix(hostname)) {
      throw new Error(
        `${ENV_NAME} rejects "${raw.trim()}": a public suffix matches hosts the operator did not name`,
      );
    }
    patterns.push({ wildcard, hostname });
  }
  return patterns;
}

/** Whether `hostname` is one the operator listed. A wildcard matches subdomains only, never the apex. */
export function hostMatchesProxyConnectPatterns(
  hostname: string,
  patterns: readonly ProxyConnectHostPattern[],
): boolean {
  const host = hostname.trim().toLowerCase().replace(/\.$/, "");
  for (const pattern of patterns) {
    if (!pattern.wildcard && host === pattern.hostname) return true;
    if (pattern.wildcard && host.endsWith(`.${pattern.hostname}`)) return true;
  }
  return false;
}
