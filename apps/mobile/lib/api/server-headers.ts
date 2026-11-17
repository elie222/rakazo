import { parseServerHeaders } from "@rakazo/contracts";
import * as SecureStore from "expo-secure-store";

const SERVER_HEADERS_KEY = "rakazo.server_headers";

let saved: { apiBase: string; headers: Record<string, string> } | null = null;

/** Headers configured for this server; none for any other origin. */
export function serverHeaders(apiBase: string): Record<string, string> {
  return saved?.apiBase === apiBase ? saved.headers : {};
}

/** Headers for a request URL, only when it is on the server they were configured for. */
export function serverHeadersForUrl(url: string, apiBase: string): Record<string, string> {
  try {
    return new URL(url).origin === new URL(apiBase).origin ? serverHeaders(apiBase) : {};
  } catch {
    return {};
  }
}

export async function loadServerHeaders(apiBase: string): Promise<void> {
  let stored: string | null = null;
  try {
    stored = await SecureStore.getItemAsync(SERVER_HEADERS_KEY);
  } catch {
    // SecureStore is unavailable in some test / web hosts.
  }
  saved = null;
  if (!stored) return;
  try {
    const value = JSON.parse(stored) as { apiBase?: unknown; headers?: unknown };
    const headers = parseServerHeaders(value.headers);
    if (value.apiBase === apiBase && headers) saved = { apiBase, headers };
  } catch {
    // A damaged value sends nothing rather than something unexpected.
  }
}

/** Replaces the headers for `apiBase`; an empty set removes them. */
export async function saveServerHeaders(
  apiBase: string,
  headers: Record<string, string>,
): Promise<boolean> {
  const parsed = parseServerHeaders(headers);
  if (parsed === null) return false;
  headers = parsed;
  try {
    if (Object.keys(headers).length === 0) {
      await SecureStore.deleteItemAsync(SERVER_HEADERS_KEY);
      saved = null;
    } else {
      await SecureStore.setItemAsync(SERVER_HEADERS_KEY, JSON.stringify({ apiBase, headers }));
      saved = { apiBase, headers };
    }
    return true;
  } catch {
    return false;
  }
}

/** Native fetch does not reliably strip custom headers on cross-origin redirects. */
export function fetchServer(
  input: Parameters<typeof fetch>[0],
  init: RequestInit,
  apiBase: string,
  fetchImpl: typeof fetch = fetch,
): ReturnType<typeof fetch> {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const extra = Object.entries(serverHeadersForUrl(url, apiBase));
  if (extra.length === 0) return fetchImpl(input, init);
  const headers = new Headers(init.headers);
  for (const [name, value] of extra) headers.set(name, value);
  return fetchImpl(input, { ...init, headers, redirect: "error" });
}
