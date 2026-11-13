import { redactSecrets } from "@rakazo/core";

export function combineSignals(...signals: Array<AbortSignal | undefined>): AbortSignal {
  return AbortSignal.any(signals.filter((signal): signal is AbortSignal => Boolean(signal)));
}

/** The error's message, or for one without (e.g. a happy-eyeballs AggregateError) what its
 * inner errors, cause, name or code say, so a failure never reads as an empty string. */
function errorMessage(error: unknown, depth = 0): string {
  if (!(error instanceof Error)) return String(error) || "unknown error";
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

export function sanitizeConnectorError(error: unknown, secrets: string[] = []): string {
  const message = errorMessage(error);
  return redactSecrets(
    message
      .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
      .replace(/trg_(?:live|test)_[A-Za-z0-9_-]+/g, "[redacted]"),
    secrets,
  ).slice(0, 2_000);
}

export function redactConnectorPayload(value: unknown, secrets: string[]): unknown {
  if (secrets.length === 0) return value;
  return maskPayload(value, (text) => redactSecrets(text, secrets));
}

/**
 * `value` as JSON with `mask` applied to every string in it, keys included, and to every number
 * and boolean as written; `{ ok: true }` when it is not JSON.
 */
export function maskPayload(value: unknown, mask: (text: string) => string): unknown {
  try {
    return maskPayloadValue(JSON.parse(JSON.stringify(value)), mask);
  } catch {
    return { ok: true };
  }
}

function maskPayloadValue(value: unknown, mask: (text: string) => string): unknown {
  if (typeof value === "string") return mask(value);
  if (Array.isArray(value)) return value.map((item) => maskPayloadValue(item, mask));
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    const serialized = String(value);
    return mask(serialized) === serialized ? value : "[redacted]";
  }
  if (typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [mask(key), maskPayloadValue(item, mask)]),
  );
}
