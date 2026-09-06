import { redactSensitiveText } from "./redaction.js";
import type { SerializedError } from "./types.js";

const MAX_CAUSE_DEPTH = 5;

export function serializeError(error: unknown, seen = new Set<unknown>()): SerializedError {
  if (!(error instanceof Error)) {
    return { name: "Error", message: stringifyUnknown(error) };
  }
  if (seen.has(error)) {
    return { name: error.name, message: "[Circular]" };
  }
  seen.add(error);
  const serialized: SerializedError = {
    name: error.name || "Error",
    message: redactSensitiveText(error.message),
  };
  if (typeof error.stack === "string" && error.stack.length > 0) {
    serialized.stack = redactSensitiveText(error.stack);
  }
  if (error.cause !== undefined && seen.size < MAX_CAUSE_DEPTH) {
    serialized.cause = serializeError(error.cause, seen);
  }
  return serialized;
}

function stringifyUnknown(value: unknown): string {
  if (typeof value === "string") return redactSensitiveText(value);
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  try {
    return redactSensitiveText(JSON.stringify(value) ?? String(value));
  } catch {
    return Object.prototype.toString.call(value);
  }
}
