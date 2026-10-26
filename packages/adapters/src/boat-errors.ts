import { setTimeout as delay } from "node:timers/promises";
import { FetchError, ResponseError } from "@boatdev/sdk";
import { SandboxRateLimitError, SandboxUnresponsiveError } from "@rakazo/adapter-kit";
import { redactSecrets } from "@rakazo/core";
import { readBodyCapped } from "./web-ssrf.js";

const MAX_BOAT_ERROR_RESPONSE_BYTES = 16 * 1024;
const BOAT_ERROR_RESPONSE_TIMEOUT_MS = 2_000;

/** An SDK `ResponseError` that keeps Boat's machine-readable error code. */
export class BoatApiError extends ResponseError {
  constructor(
    response: Response,
    message: string,
    readonly code: string | undefined,
  ) {
    super(response, message);
  }
}

const BOAT_RETRY_DELAY_MS = 1_000;
// Failures before a TCP connection exists: the request never left this host.
const UNSENT_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
]);
const TRANSIENT_STATUSES = new Set([500, 502, 503, 504]);

/**
 * Keep HTTP failures actionable without changing the SDK's status-based recovery contract.
 * A brief Boat outage is retried once: any call whose request never arrived, and an
 * `idempotent` call that Boat failed on its side. A sandbox that took the request and did not
 * answer in time would only time out again, so that is never resent.
 */
export function wrapBoatCall<Args extends unknown[], Result>(
  call: (...args: Args) => Promise<Result>,
  apiKey: string,
  idempotent = false,
): (...args: Args) => Promise<Result> {
  const attempt = async (...args: Args): Promise<Result> => {
    try {
      return await call(...args);
    } catch (error) {
      // The connection to Boat failed without an answer. The request may have arrived, so it
      // is not resent unless it never left; background work tries again on its next pass.
      if (error instanceof FetchError && !aborted(error, callerSignal(args[1]))) {
        throw new SandboxUnresponsiveError("Boat could not be reached", { cause: error });
      }
      if (!(error instanceof ResponseError)) throw error;
      const wrapped = await boatResponseError(error.response, apiKey);
      if (error.response.status === 429) throw new SandboxRateLimitError({ cause: wrapped });
      // Boat's proxy reached the sandbox but gave up waiting for its answer.
      if (wrapped.code === "sandbox_direct_failed" && /\btimeout\b/i.test(wrapped.message)) {
        throw new SandboxUnresponsiveError(wrapped.message, { cause: wrapped });
      }
      throw wrapped;
    }
  };
  return async (...args) => {
    try {
      return await attempt(...args);
    } catch (error) {
      if (!unsent(error) && !(idempotent && failedAtBoat(error))) throw error;
      await delay(BOAT_RETRY_DELAY_MS, undefined, { signal: callerSignal(args[1]) });
      return attempt(...args);
    }
  };
}

/** The `RequestInit` signal the SDK takes as each operation's second argument. */
export function callerSignal(init: unknown): AbortSignal | undefined {
  const signal = (init as RequestInit | undefined)?.signal;
  return signal instanceof AbortSignal ? signal : undefined;
}

/** True when neither Boat nor the sandbox received the request, so sending it again is safe. */
function unsent(error: unknown): boolean {
  // Boat's proxy could not open a connection to the sandbox machine.
  if (error instanceof BoatApiError) {
    return error.code === "sandbox_direct_failed" && /\bECONNREFUSED\b/.test(error.message);
  }
  let current = error;
  for (let depth = 0; current instanceof Error && depth < 4; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && UNSENT_CODES.has(code)) return true;
    // Reset during the TLS handshake, before any of the request was written.
    if (code === "ECONNRESET" && /before secure TLS connection/.test(current.message)) return true;
    current = current.cause;
  }
  return false;
}

/** A fetch the caller cancelled or that ran out of time, rather than one the network lost. */
function aborted(error: FetchError, signal: AbortSignal | undefined): boolean {
  const name = error.cause instanceof Error ? error.cause.name : undefined;
  return signal?.aborted === true || name === "AbortError" || name === "TimeoutError";
}

function failedAtBoat(error: unknown): boolean {
  return error instanceof BoatApiError && TRANSIENT_STATUSES.has(error.response.status);
}

export async function boatResponseError(
  response: Response,
  apiKey: string,
  signal?: AbortSignal,
): Promise<BoatApiError> {
  const body = await readErrorBody(response, signal);
  const code = safeIdentifier(body?.code);
  const requestId = safeIdentifier(body?.requestId);
  const prefix = `Boat API request failed (HTTP ${response.status}${code ? `, ${code}` : ""})`;
  const detail =
    typeof body?.message === "string"
      ? redactSecrets(body.message, [apiKey])
          .replace(/https?:\/\/[^\s<>"']+/gi, "[redacted URL]")
          .replace(/Bearer\s+[^\s,;]+/gi, "Bearer [redacted]")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 512)
      : "";
  return new BoatApiError(
    response,
    redactSecrets(
      `${prefix}${detail ? `: ${detail}` : ""}${requestId ? ` (request ${requestId})` : ""}`,
      [apiKey],
    ),
    code,
  );
}

function safeIdentifier(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-zA-Z0-9_.-]{1,128}$/.test(value) ? value : undefined;
}

async function readErrorBody(
  response: Response,
  signal?: AbortSignal,
): Promise<Record<string, unknown> | undefined> {
  const readSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(BOAT_ERROR_RESPONSE_TIMEOUT_MS)])
    : AbortSignal.timeout(BOAT_ERROR_RESPONSE_TIMEOUT_MS);
  try {
    const bytes = await readBodyCapped(response, MAX_BOAT_ERROR_RESPONSE_BYTES, readSignal);
    const body: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return body !== null && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}
