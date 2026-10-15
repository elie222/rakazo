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
  "mimeType",
  "data",
  "encrypted_content",
]);
const SERIALIZED_MODEL_FIELDS: ReadonlySet<string> = new Set([
  "thinkingSignature",
  "textSignature",
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
    Object.entries(value).map(([key, item]) => {
      if (typeof item === "string" && protocolFields.has(key)) return [key, item];
      if (typeof item === "string" && SERIALIZED_MODEL_FIELDS.has(key))
        return [key, redactSerializedModelValue(item, secrets, protocolFields)];
      return [
        key,
        redactModelValue(item, secrets, key === "arguments" ? NO_PROTOCOL_FIELDS : protocolFields),
      ];
    }),
  );
}

function redactSerializedModelValue(
  value: string,
  secrets: string[],
  protocolFields: ReadonlySet<string>,
): string {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object"
      ? JSON.stringify(redactModelValue(parsed, secrets, protocolFields))
      : value;
  } catch {
    return value;
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
