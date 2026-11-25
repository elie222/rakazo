import { redactJsonStringsAndPlainText, redactSecrets, sliceWellFormed } from "@rakazo/core";

export function combineSignals(...signals: Array<AbortSignal | undefined>): AbortSignal {
  return AbortSignal.any(signals.filter((signal): signal is AbortSignal => Boolean(signal)));
}

/** The error's message, or for one without (e.g. a happy-eyeballs AggregateError) what its
 * inner errors, cause, name or code say, so a failure never reads as an empty string. */
function errorMessage(error: unknown, depth = 0): string {
  if (!(error instanceof Error)) {
    if (typeof error === "string") return error || "unknown error";
    try {
      return String(error) || "unknown error";
    } catch {
      return "unknown error";
    }
  }
  if (error.message) return error.message;
  if (depth < 3) {
    const inner = error instanceof AggregateError ? error.errors[0] : error.cause;
    if (inner !== undefined) return errorMessage(inner, depth + 1);
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" || typeof code === "number"
    ? `${error.name} ${code}`
    : `${error.name} without a message`;
}

export function sanitizeConnectorError(
  error: unknown,
  secrets: string[] = [],
  options?: { maxChars?: number },
): string {
  const message = errorMessage(error);
  const sanitizeDecoded = (value: string) =>
    redactSecrets(
      value
        .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
        .replace(/trg_(?:live|test)_[A-Za-z0-9_-]+/g, "[redacted]"),
      secrets,
    );
  const sanitizePlain = (value: string) =>
    redactSecrets(
      value
        .replace(/Bearer\s+(?:"[^"\r\n]*"?|'[^'\r\n]*'?|[^\s"',;&}]+)/gi, "Bearer [redacted]")
        .replace(/trg_(?:live|test)_[A-Za-z0-9_-]+/g, "[redacted]"),
      secrets,
    );
  const cleaned = redactSecrets(
    redactJsonStringsAndPlainText(message, sanitizeDecoded, sanitizePlain),
    secrets,
  );
  const maxChars = options?.maxChars ?? 2_000;
  return Number.isFinite(maxChars) ? sliceWellFormed(cleaned, maxChars) : cleaned;
}

export function redactConnectorPayload(value: unknown, secrets: string[]): unknown {
  if (secrets.length === 0) return value;
  try {
    return redactPayloadValue(JSON.parse(JSON.stringify(value)), secrets);
  } catch {
    return { ok: true };
  }
}

function redactPayloadValue(value: unknown, secrets: string[]): unknown {
  if (typeof value === "string") return redactSecrets(value, secrets);
  if (Array.isArray(value)) return value.map((item) => redactPayloadValue(item, secrets));
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    const serialized = String(value);
    return redactSecrets(serialized, secrets) === serialized ? value : "[redacted]";
  }
  if (typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      redactSecrets(key, secrets),
      redactPayloadValue(item, secrets),
    ]),
  );
}
