import { ResponseError } from "@boatdev/sdk";
import { SandboxRateLimitError } from "@rakazo/adapter-kit";
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

/** Keep HTTP failures actionable without changing the SDK's status-based recovery contract. */
export function wrapBoatCall<Args extends unknown[], Result>(
  call: (...args: Args) => Promise<Result>,
  apiKey: string,
): (...args: Args) => Promise<Result> {
  return async (...args) => {
    try {
      return await call(...args);
    } catch (error) {
      if (!(error instanceof ResponseError)) throw error;
      const wrapped = await boatResponseError(error.response, apiKey);
      if (error.response.status === 429) throw new SandboxRateLimitError({ cause: wrapped });
      throw wrapped;
    }
  };
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
