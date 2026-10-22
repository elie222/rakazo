import { parse } from "tldts";

/**
 * Who a request trusts, by site: the registrable domain, or the address itself for an IP literal.
 * Every subdomain of a site belongs to it, so `docs.example.com` is the same site as
 * `example.com`. Shared hosts on the public suffix list's private section count each tenant as its
 * own site, so trusting `alice.github.io` never trusts `attacker.github.io`.
 *
 * This lives behind its own entry point so clients that never decide policy skip the suffix list.
 */
export function hostSite(hostname: string): string | undefined {
  return siteOf(hostname, true);
}

/**
 * The registrable domain on ICANN suffixes only, for contacting a host without sending anything a
 * subdomain carries. A private suffix entry is not used here: anyone can request one for a domain
 * they control, which would let its subdomains reach their DNS.
 */
export function registrableDomain(hostname: string): string | undefined {
  return siteOf(hostname, false);
}

function siteOf(hostname: string, allowPrivateDomains: boolean): string | undefined {
  const host = hostname.trim().toLowerCase().replace(/\.$/, "");
  if (!host) return undefined;
  const parsed = parse(host, { allowPrivateDomains });
  if (parsed.isIp || host.startsWith("[")) return host;
  return parsed.domain ?? host;
}

/** The site an http(s) URL is sent to, or undefined for anything else. */
export function urlSite(input: string): string | undefined {
  const url = httpUrl(input);
  return url ? hostSite(url.hostname) : undefined;
}

/** The URL normalized the way it is compared and sent, or undefined when it is not http(s). */
export function normalizedHttpUrl(input: string): string | undefined {
  return httpUrl(input)?.href;
}

const URL_IN_TEXT = /\bhttps?:\/\/[^\s<>"'`]+/gi;
const DOMAIN_IN_TEXT =
  /(?<![\w@.-])(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}[a-z0-9](?![\w-])/gi;

/**
 * The sites a person named in their own words: http(s) links and bare domain names on a known
 * public suffix. An address after `@` is an email, not a site to fetch.
 */
export function sitesInText(text: string): Set<string> {
  const sites = new Set<string>();
  for (const [match] of text.matchAll(URL_IN_TEXT)) {
    const site = urlSite(match.replace(/[.,;:!?)\]}]+$/, ""));
    if (site) sites.add(site);
  }
  // A link grants only its own host: a domain in its path or query is not one the person named.
  const withoutLinks = text.replace(URL_IN_TEXT, " ");
  for (const [match] of withoutLinks.matchAll(DOMAIN_IN_TEXT)) {
    const parsed = parse(match.toLowerCase(), { allowPrivateDomains: true });
    if ((parsed.isIcann || parsed.isPrivate) && parsed.domain) sites.add(parsed.domain);
  }
  return sites;
}

function httpUrl(input: string): URL | undefined {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return undefined;
  }
  return url.protocol === "http:" || url.protocol === "https:" ? url : undefined;
}
