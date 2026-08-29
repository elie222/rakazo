const DEFAULT_API = process.env.EXPO_PUBLIC_API_URL ?? "http://127.0.0.1:3100";

export type EndpointResult = { ok: true; url: string } | { ok: false; error: string };

export function defaultApiBase() {
  return originOnly(DEFAULT_API) ?? DEFAULT_API.replace(/\/+$/, "");
}

export function normalizeApiBase(input: string): EndpointResult {
  const trimmed = input.trim();
  if (!trimmed) return { ok: false, error: "Enter a server URL" };
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    return { ok: false, error: "That doesn’t look like a URL" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, error: "Use an http or https URL" };
  }
  if (!parsed.hostname) return { ok: false, error: "That URL is missing a host" };
  const url = `${parsed.protocol}//${parsed.host}`;
  return { ok: true, url };
}

export function displayApiHost(url: string) {
  try {
    const parsed = new URL(url);
    return parsed.host;
  } catch {
    return url;
  }
}

export function usesCustomApiBase(url: string, fallback = defaultApiBase()) {
  return url !== fallback;
}

export function apiBaseWarning(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "http:" && !isLanOrLocalHost(parsed.hostname)) {
      return "Public servers need https://. HTTP only works on your local network.";
    }
  } catch {
    return null;
  }
  return null;
}

export async function probeApiBase(
  input: string,
  fetchImpl: typeof fetch = fetch,
): Promise<EndpointResult> {
  const parsed = normalizeApiBase(input);
  if (!parsed.ok) return parsed;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const res = await fetchImpl(`${parsed.url}/rpc/health`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "rakazo://" },
      body: JSON.stringify({ json: {} }),
      signal: controller.signal,
    });
    const body = (await res.json().catch(() => ({}))) as {
      json?: { ok?: boolean };
      error?: { message?: string };
    };
    if (!res.ok || body.error || body.json?.ok !== true) {
      return { ok: false, error: "That URL did not look like a Rakazo server" };
    }
    return parsed;
  } catch {
    return { ok: false, error: "Could not reach that server" };
  } finally {
    clearTimeout(timer);
  }
}

function originOnly(value: string) {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return null;
  }
}

function isLanOrLocalHost(hostname: string) {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") return true;
  if (host.endsWith(".local")) return true;
  if (/^10(?:\.\d{1,3}){3}$/.test(host)) return true;
  if (/^192\.168(?:\.\d{1,3}){2}$/.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])(?:\.\d{1,3}){2}$/.test(host)) return true;
  if (/^100\.(6[4-9]|[7-9]\d|1[0-1]\d|12[0-7])(?:\.\d{1,3}){2}$/.test(host)) return true;
  return false;
}
