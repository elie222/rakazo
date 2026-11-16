import type { LogEvent } from "./types.js";

// A hosted store takes a batch of lines in one request, so one line it refuses, or one that
// cannot be serialized, loses every line sent with it. Lines are already redacted here, and
// shortening one only ever removes text.
export const MAX_LOG_STRING_CHARS = 16_384;
export const MAX_LOG_EVENT_CHARS = 262_144;
const STAND_IN_STRING_CHARS = 1_024;

export function boundLogEvent(event: LogEvent): Record<string, unknown> {
  let truncated = false;
  let json: string;
  try {
    json = JSON.stringify(event, (_key, value: unknown) => {
      if (typeof value === "bigint") return value.toString();
      if (typeof value !== "string" || value.length <= MAX_LOG_STRING_CHARS) return value;
      truncated = true;
      return cap(value, MAX_LOG_STRING_CHARS);
    });
  } catch {
    return standIn(event, "log.unserializable");
  }
  if (json.length > MAX_LOG_EVENT_CHARS) return standIn(event, "log.oversized");
  if (!truncated) return event;
  return { ...JSON.parse(json), "log.truncated": true };
}

function cap(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}… [${value.length - limit} more characters]`;
}

/** The line's plain top-level fields and its error's name and message, each shortened. */
function standIn(event: LogEvent, flag: string): Record<string, unknown> {
  const kept: Record<string, unknown> = { [flag]: true };
  const fields: Array<[string, unknown]> = Object.entries(event);
  if (event.error) {
    fields.push(["error.name", event.error.name], ["error.message", event.error.message]);
  }
  let size = 0;
  for (const [key, value] of fields) {
    if (typeof value === "string") {
      if (size > MAX_LOG_EVENT_CHARS / 2) continue;
      kept[key] = cap(value, STAND_IN_STRING_CHARS);
      size += key.length + STAND_IN_STRING_CHARS;
    } else if (typeof value === "number" || typeof value === "boolean") {
      kept[key] = value;
    }
  }
  return kept;
}
