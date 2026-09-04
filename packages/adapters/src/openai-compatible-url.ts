import { isIP } from "node:net";
import { OPENAI_COMPATIBLE_PROVIDER_ID } from "@rakazo/contracts";
import { isLinkLocalAddress, isPrivateAddress } from "./network-address.js";

export { OPENAI_COMPATIBLE_PROVIDER_ID };

const METADATA_HOSTS = new Set(["metadata.google.internal", "metadata.goog", "169.254.169.254"]);

export function openAiCompatAllowPublicHosts(): boolean {
  return process.env.RAKAZO_OPENAI_COMPAT_ALLOW_PUBLIC === "1";
}

export function normalizeOpenAiCompatibleBaseUrl(raw: string): string {
  const trimmed = raw.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error("Base URL must be an absolute HTTP(S) URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Base URL must use http or https");
  }
  if (url.username || url.password) {
    throw new Error("Base URL must not contain credentials");
  }
  let path = url.pathname.replace(/\/+$/, "") || "";
  const VERSIONED_API_ROOT = /\/v\d+$/;
  if (!VERSIONED_API_ROOT.test(path)) {
    path = path ? `${path}/v1` : "/v1";
  }
  return `${url.origin}${path}`;
}

function normalizeHostname(hostname: string): string {
  return hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
}

export function isPrivateOpenAiCompatibleHostname(hostname: string): boolean {
  const normalized = normalizeHostname(hostname);
  if (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized === "host.docker.internal"
  ) {
    return true;
  }
  if (METADATA_HOSTS.has(normalized)) return false;
  const ipKind = isIP(normalized);
  if (ipKind === 4 || ipKind === 6) return isPrivateAddress(normalized);
  return false;
}

function isBlockedHostname(hostname: string): boolean {
  const normalized = normalizeHostname(hostname);
  return (
    METADATA_HOSTS.has(normalized) || (isIP(normalized) !== 0 && isLinkLocalAddress(normalized))
  );
}

export function assertAllowedOpenAiCompatibleUrl(
  raw: string,
  opts?: { allowPublic?: boolean },
): URL {
  const normalized = normalizeOpenAiCompatibleBaseUrl(raw);
  return assertAllowedOpenAiCompatibleRequestUrl(normalized, opts);
}

/**
 * When an API key will be sent, refuse public http:// endpoints so the Bearer
 * token is not cleartext on the public internet. Private / loopback http stays
 * allowed (local model servers). https:// is always fine for this check.
 */
export function assertHttpsForKeyedOpenAiCompatibleUrl(
  url: URL,
  apiKey: string | undefined | null,
): void {
  if (!apiKey?.trim()) return;
  if (url.protocol === "https:") return;
  const hostname = normalizeHostname(url.hostname);
  if (isPrivateOpenAiCompatibleHostname(hostname)) return;
  throw new Error(
    "OpenAI-compatible endpoints that send an API key must use HTTPS. Use an https:// URL, or omit the API key on a private HTTP endpoint.",
  );
}

export function assertAllowedOpenAiCompatibleRequestUrl(
  raw: string,
  opts?: { allowPublic?: boolean },
): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Model server URL must be an absolute HTTP(S) URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Model server URL must use http or https");
  }
  if (url.username || url.password) {
    throw new Error("Model server URL must not contain credentials");
  }
  const hostname = normalizeHostname(url.hostname);
  if (isBlockedHostname(hostname)) {
    throw new Error("Base URL targets a blocked metadata or link-local host");
  }
  const allowPublic = opts?.allowPublic ?? openAiCompatAllowPublicHosts();
  if (isPrivateOpenAiCompatibleHostname(hostname)) return url;
  if (!allowPublic) {
    throw new Error(
      "Public model endpoints are blocked. Set RAKAZO_OPENAI_COMPAT_ALLOW_PUBLIC=1 to allow them.",
    );
  }
  return url;
}
