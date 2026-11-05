import { lookup } from "node:dns/promises";
import {
  ipVersion,
  isCloudMetadataAddress,
  isLinkLocalAddress,
  isLocalhostOrLoopbackIp,
  isNonPublicAddress,
  normalizeHost,
} from "@rakazo/contracts";
import {
  assertLocalServiceBaseUrl,
  assertLocalServiceBaseUrlSync,
  parseServiceBaseUrl,
} from "./local-service-endpoint.js";
import type { ResolvedAddress, ResolveHostname } from "./network-address.js";
import { egressRefused } from "./network-address.js";
import { isPrivateRemoteMcpHostname } from "./remote-mcp.js";

const BLOCKED_TARGET_ERROR = "Memory base URL targets a blocked address.";

const defaultResolveHostname: ResolveHostname = (hostname) =>
  lookup(hostname, { all: true, verbatim: true });

/** Parses and normalizes a Memmy base URL: HTTP(S), no credentials, no trailing slash. */
export function normalizeMemmyBaseUrl(rawBaseUrl: string | undefined): string {
  const trimmed = rawBaseUrl?.trim();
  if (!trimmed) throw new Error("baseUrl is required");
  return parseServiceBaseUrl(trimmed).href.replace(/\/+$/, "");
}

/**
 * Loopback, RFC1918/ULA literals, internal names (.local, .internal, localhost) and single-label
 * names (Compose DNS) reach the server network. Plain HTTP to a public-looking name is treated the
 * same way, as Serenity does: it may be LAN DNS, and the pinned transport then requires it to
 * resolve privately. Fails closed on a missing or bad URL.
 */
function baseUrlLooksPrivate(rawBaseUrl: string | undefined): boolean {
  let url: URL;
  try {
    url = new URL(normalizeMemmyBaseUrl(rawBaseUrl));
  } catch {
    return true;
  }
  const host = normalizeHost(url.hostname);
  if (isLocalhostOrLoopbackIp(host) || isPrivateRemoteMcpHostname(host)) return true;
  if (ipVersion(host) === 0 && !host.includes(".")) return true;
  return url.protocol === "http:";
}

/**
 * True when the endpoint reaches the server network, so the operator must authorize it: either
 * classification found private DNS answers, or the URL alone says so.
 */
export function memmyRequiresPrivateEndpoint(settings: Record<string, string>): boolean {
  return settings.endpointTrust === "private" || baseUrlLooksPrivate(settings.baseUrl);
}

async function endpointIsPrivate(baseUrl: string, resolve: ResolveHostname): Promise<boolean> {
  if (baseUrlLooksPrivate(baseUrl)) {
    // Metadata names and link-local literals are refused before anything resolves.
    assertLocalServiceBaseUrlSync(baseUrl);
    return true;
  }
  const host = normalizeHost(new URL(baseUrl).hostname);
  const family = ipVersion(host);
  const addresses: ResolvedAddress[] =
    family === 0 ? await resolve(host) : [{ address: host, family }];
  if (addresses.length === 0) throw new Error("Memory base URL did not resolve to an address.");
  if (
    addresses.some(
      (entry) => isCloudMetadataAddress(entry.address) || isLinkLocalAddress(entry.address),
    )
  ) {
    throw egressRefused(host, new Error(BLOCKED_TARGET_ERROR));
  }
  return addresses.some((entry) => isNonPublicAddress(entry.address));
}

/**
 * DNS/trust classification without contacting Memmy. A public-looking HTTPS name that resolves to
 * the server network is marked private, so the operator gate applies to it too. Public endpoints
 * carry no trust field; their transport checks every connection instead.
 */
export async function classifyMemmyConnectionSettings(
  settings: Record<string, string>,
  resolveHostname: ResolveHostname = defaultResolveHostname,
): Promise<Record<string, string>> {
  const baseUrl = normalizeMemmyBaseUrl(settings.baseUrl);
  const { endpointTrust: _previous, ...rest } = settings;
  const classified: Record<string, string> = { ...rest, baseUrl };
  if (await endpointIsPrivate(baseUrl, resolveHostname)) classified.endpointTrust = "private";
  return classified;
}

/** Recheck a saved private endpoint's DNS before its credentials are decrypted. */
export async function revalidateMemmySettings(settings: Record<string, string>): Promise<void> {
  if (!memmyRequiresPrivateEndpoint(settings)) return;
  await assertLocalServiceBaseUrl(normalizeMemmyBaseUrl(settings.baseUrl), {
    allowPrivateEndpoint: true,
  });
}
