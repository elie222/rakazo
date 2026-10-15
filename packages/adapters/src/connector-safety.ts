import { redactSecrets } from "@rakazo/core";

export function combineSignals(...signals: Array<AbortSignal | undefined>): AbortSignal {
  return AbortSignal.any(signals.filter((signal): signal is AbortSignal => Boolean(signal)));
}

export function sanitizeConnectorError(error: unknown, secrets: string[] = []): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactSecrets(
    message
      .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
      .replace(/trg_(?:live|test)_[A-Za-z0-9_-]+/g, "[redacted]"),
    secrets,
  ).slice(0, 2_000);
}

export function redactConnectorPayload(value: unknown, secrets: string[]): unknown {
  if (secrets.length === 0) return value;
  try {
    return redactPayloadValue(JSON.parse(JSON.stringify(value)), secrets);
  } catch {
    return { ok: true };
  }
}

const MODEL_PROTOCOL_FIELDS: ReadonlySet<string> = new Set([
  "role",
  "type",
  "id",
  "parentId",
  "toolCallId",
  "toolName",
  "name",
  "api",
  "provider",
  "model",
  "stopReason",
  "customType",
]);
const NO_PROTOCOL_FIELDS: ReadonlySet<string> = new Set();

export function redactModelContextSecrets<T>(value: T, secrets: string[]): T {
  return redactModelValue(value, secrets, MODEL_PROTOCOL_FIELDS) as T;
}

function redactModelValue(
  value: unknown,
  secrets: string[],
  protocolFields: ReadonlySet<string>,
): unknown {
  if (typeof value === "string") return redactSecrets(value, secrets);
  if (typeof value === "number") return secrets.includes(String(value)) ? "[redacted]" : value;
  if (Array.isArray(value))
    return value.map((item) => redactModelValue(item, secrets, protocolFields));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      protocolFields.has(key) && typeof item === "string"
        ? item
        : redactModelValue(
            item,
            secrets,
            key === "arguments" ? NO_PROTOCOL_FIELDS : protocolFields,
          ),
    ]),
  );
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
