import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Agent } from "undici";
import {
  createAddressCheckedLookup,
  isPrivateAddress,
  type ResolvedAddress,
  type ResolveHostname,
} from "./network-address.js";

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const MAX_REDIRECTS = 5;

export type { ResolveHostname } from "./network-address.js";

export interface SafeWebFetchOptions {
  fetch?: typeof globalThis.fetch;
  resolveHostname?: ResolveHostname;
  timeoutMs?: number;
  maxBytes?: number;
  userAgent?: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /**
   * Test seam for dispatcher teardown. Defaults to `Agent.close()`.
   * Always raced against the shared operation deadline.
   */
  cleanup?: () => Promise<void>;
  /**
   * Test seam for force-teardown after cleanup. Defaults to `Agent.destroy()`.
   * Invoked without awaiting so a hanging destroy cannot extend the deadline.
   * May return a Promise (`Agent.destroy()` does); rejections are swallowed.
   */
  destroy?: () => void | Promise<void>;
}

const defaultResolveHostname: ResolveHostname = (hostname) =>
  lookup(hostname, { all: true, verbatim: true });

export async function assertSafeWebUrl(
  value: string,
  resolve: ResolveHostname = defaultResolveHostname,
  signal?: AbortSignal,
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("URL is invalid");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only http: and https: URLs are allowed");
  }
  if (url.username || url.password) {
    throw new Error("URL must not contain credentials");
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (isBlockedHostname(hostname)) {
    throw new Error("URL targets a private or internal host");
  }
  assertPublicAddresses(await withAbort(resolve(hostname), signal));
  return url;
}

export function isBlockedHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/, "");
  if (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local") ||
    normalized.endsWith(".internal") ||
    normalized === "metadata.google.internal" ||
    normalized === "metadata.goog"
  ) {
    return true;
  }
  if (isIP(normalized) !== 0) return isPrivateAddress(normalized);
  return false;
}

export async function fetchSafeWebText(
  url: string,
  options: SafeWebFetchOptions = {},
): Promise<{ url: string; body: string; contentType: string | null }> {
  const resolve = options.resolveHostname ?? defaultResolveHostname;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const baseFetch = options.fetch ?? globalThis.fetch;
  const dispatcher = new Agent({
    connect: { lookup: createAddressCheckedLookup(resolve, assertPublicAddresses) },
  });
  // One deadline for the whole redirect chain + body read + cleanup, not per hop.
  const signal = combineSignals(options.signal, AbortSignal.timeout(timeoutMs));
  const cleanup =
    options.cleanup ??
    (() =>
      dispatcher.close().then(
        () => undefined,
        () => undefined,
      ));
  const destroy = options.destroy ?? (() => dispatcher.destroy());

  try {
    return await followRedirects(url, {
      baseFetch,
      resolve,
      dispatcher,
      maxBytes,
      userAgent: options.userAgent ?? "Rakazo/0.1 (+https://github.com/elie222/rakazo)",
      headers: options.headers,
      signal,
      redirectsRemaining: MAX_REDIRECTS,
    });
  } finally {
    // Race graceful close against the shared deadline. Do not wait unbounded on close().
    await withAbort(cleanup(), signal).catch(() => undefined);
    // If the deadline aborted (close hung or already timed out), force-destroy
    // without awaiting so sockets/FDs cannot leak past the timeout.
    // Agent.destroy() returns a Promise — swallow async rejection (sync try/catch cannot).
    if (signal.aborted) {
      try {
        void Promise.resolve(destroy()).catch(() => undefined);
      } catch {
        // sync throw from destroy seam
      }
    }
  }
}

async function followRedirects(
  rawUrl: string,
  state: {
    baseFetch: typeof globalThis.fetch;
    resolve: ResolveHostname;
    dispatcher: Agent;
    maxBytes: number;
    userAgent: string;
    headers?: Record<string, string>;
    signal: AbortSignal;
    redirectsRemaining: number;
  },
): Promise<{ url: string; body: string; contentType: string | null }> {
  if (state.signal.aborted) {
    throw abortError(state.signal);
  }
  const validated = await assertSafeWebUrl(rawUrl, state.resolve, state.signal);
  // Race fetch against the deadline — injected fetch may ignore init.signal.
  const response = await withAbort(
    state.baseFetch(validated.href, {
      method: "GET",
      redirect: "manual",
      signal: state.signal,
      headers: {
        "user-agent": state.userAgent,
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5",
        ...state.headers,
      },
      dispatcher: state.dispatcher,
    } as RequestInit & { dispatcher: Agent }),
    state.signal,
  );

  if (response.status >= 300 && response.status < 400) {
    if (state.redirectsRemaining <= 0) {
      await cancelResponseBody(response, state.signal);
      throw new Error("Too many redirects");
    }
    const location = response.headers.get("location");
    if (!location) {
      await cancelResponseBody(response, state.signal);
      throw new Error("Redirect missing Location header");
    }
    const next = new URL(location, validated.href);
    const headers = next.origin === validated.origin ? state.headers : undefined;
    // Release this hop before following — do not leave the body open across recursion.
    await cancelResponseBody(response, state.signal);
    return followRedirects(next.href, {
      ...state,
      headers,
      redirectsRemaining: state.redirectsRemaining - 1,
    });
  }

  if (!response.ok) {
    await cancelResponseBody(response, state.signal);
    throw new Error(`Request failed: HTTP ${response.status}`);
  }

  const contentLength = response.headers.get("content-length");
  if (contentLength && Number(contentLength) > state.maxBytes) {
    await cancelResponseBody(response, state.signal);
    throw new Error("Response is too large");
  }

  const buffer = await readBodyCapped(response, state.maxBytes, state.signal);

  return {
    url: validated.href,
    body: new TextDecoder().decode(buffer),
    contentType: response.headers.get("content-type"),
  };
}

async function cancelResponseBody(response: Response, signal: AbortSignal): Promise<void> {
  const cancel = response.body?.cancel() ?? Promise.resolve();
  // A hanging cancel must not outlive the shared deadline.
  await withAbort(
    cancel.catch(() => undefined),
    signal,
  ).catch(() => undefined);
}

/** Best-effort cancel that never waits past an already-fired deadline. */
async function cancelReader(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal?: AbortSignal,
): Promise<void> {
  await withAbort(
    reader.cancel().catch(() => undefined),
    signal,
  ).catch(() => undefined);
}

/** Read the body as a stream and abort once maxBytes is exceeded (DoS guard). */
export async function readBodyCapped(
  response: Response,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  if (!response.body) {
    const buffer = await withAbort(response.arrayBuffer(), signal);
    if (buffer.byteLength > maxBytes) throw new Error("Response is too large");
    return new Uint8Array(buffer);
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      if (signal?.aborted) throw abortError(signal);
      // Race each pull against the deadline — hanging streams must not block cleanup.
      const { done, value } = await withAbort(reader.read(), signal);
      if (done) break;
      if (!value?.byteLength) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await cancelReader(reader, signal);
        throw new Error("Response is too large");
      }
      chunks.push(value);
    }
  } catch (error) {
    await cancelReader(reader, signal);
    throw error;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // already cancelled / released
    }
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function assertPublicAddresses(addresses: ResolvedAddress[]): void {
  if (addresses.length === 0 || addresses.some((entry) => isPrivateAddress(entry.address))) {
    throw new Error("URL resolves to a private address");
  }
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("Request timed out");
}

/** Race a promise against an AbortSignal so stalled work cannot outlive the deadline. */
export function withAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function combineSignals(...signals: Array<AbortSignal | undefined>): AbortSignal {
  const active = signals.filter((signal): signal is AbortSignal => Boolean(signal));
  if (active.length === 0) return new AbortController().signal;
  if (active.length === 1) return active[0]!;
  return AbortSignal.any(active);
}
