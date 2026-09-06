import { ResponseError } from "@asciidev/box-sdk";
import { redactSecrets } from "@rakazo/core";
import { readBodyCapped } from "./web-ssrf.js";

const MAX_BOX_ERROR_RESPONSE_BYTES = 16 * 1024;
const BOX_ERROR_RESPONSE_TIMEOUT_MS = 2_000;

/** Keep HTTP failures actionable without changing the SDK's status-based recovery contract. */
export function wrapBoxCall<Args extends unknown[], Result>(
  call: (...args: Args) => Promise<Result>,
  apiKey: string,
): (...args: Args) => Promise<Result> {
  return async (...args) => {
    try {
      return await call(...args);
    } catch (error) {
      if (error instanceof ResponseError) throw await boxResponseError(error.response, apiKey);
      throw error;
    }
  };
}

export async function boxResponseError(
  response: Response,
  apiKey: string,
  signal?: AbortSignal,
): Promise<ResponseError> {
  const body = await readErrorBody(response, signal);
  const code = safeIdentifier(body?.code);
  const requestId = safeIdentifier(body?.requestId);
  const prefix = `Box API request failed (HTTP ${response.status}${code ? `, ${code}` : ""})`;
  const detail =
    typeof body?.message === "string"
      ? redactSecrets(body.message, [apiKey])
          .replace(/https?:\/\/[^\s<>"']+/gi, "[redacted URL]")
          .replace(/Bearer\s+[^\s,;]+/gi, "Bearer [redacted]")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 512)
      : "";
  return new ResponseError(
    response,
    redactSecrets(
      `${prefix}${detail ? `: ${detail}` : ""}${requestId ? ` (request ${requestId})` : ""}`,
      [apiKey],
    ),
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
    ? AbortSignal.any([signal, AbortSignal.timeout(BOX_ERROR_RESPONSE_TIMEOUT_MS)])
    : AbortSignal.timeout(BOX_ERROR_RESPONSE_TIMEOUT_MS);
  try {
    const bytes = await readBodyCapped(response, MAX_BOX_ERROR_RESPONSE_BYTES, readSignal);
    const body: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return body !== null && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}
