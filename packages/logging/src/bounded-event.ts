import type { LogEvent } from "./types.js";

// A hosted store takes a batch of lines in one request, so one line it refuses, or one that
// cannot be serialized, loses every line sent with it. Lines are already redacted here, and
// shortening one only ever removes text.
export const MAX_LOG_STRING_CHARS = 16_384;
export const MAX_LOG_EVENT_CHARS = 262_144;
const ESSENTIAL_FIELDS = new Set(["timestamp", "level", "message", "service.name", "error.name"]);
const STAND_IN_KEY_CHARS = 128;
const STAND_IN = { maxFields: 64, stringChars: 1_024, include: () => true };
const SMALLEST_STAND_IN = {
  maxFields: 16,
  stringChars: 256,
  include: (key: string) => ESSENTIAL_FIELDS.has(key) || key.endsWith(".id"),
};

export function boundLogEvent(event: LogEvent): Record<string, unknown> {
  let normalized = false;
  let truncated = false;
  let json: unknown;
  try {
    json = JSON.stringify(event, (_key, value: unknown) => {
      if (typeof value === "bigint") {
        normalized = true;
        return value.toString();
      }
      if (typeof value !== "string" || value.length <= MAX_LOG_STRING_CHARS) return value;
      truncated = true;
      return cap(value, MAX_LOG_STRING_CHARS);
    });
  } catch {
    return standIn(event, "log.unserializable");
  }
  if (typeof json !== "string") return standIn(event, "log.unserializable");
  if (json.length > MAX_LOG_EVENT_CHARS) return standIn(event, "log.oversized");
  if (!normalized && !truncated) return event;
  const bounded: Record<string, unknown> = JSON.parse(json);
  if (truncated) bounded["log.truncated"] = true;
  return bounded;
}

function cap(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}… [${value.length - limit} more characters]`;
}

/**
 * The line's plain top-level fields and its error's name and message, each shortened; if even
 * that is too large, only its message, level, service, ids and error name.
 */
function standIn(event: LogEvent, flag: string): Record<string, unknown> {
  const fields: Array<[string, unknown]> = [];
  if (event.error) {
    fields.push(["error.name", event.error.name], ["error.message", event.error.message]);
  }
  fields.push(...Object.entries(event));
  // The flag goes last so no field of the same name can overwrite it.
  const kept = { ...plainFields(fields, STAND_IN), [flag]: true };
  if (JSON.stringify(kept).length <= MAX_LOG_EVENT_CHARS) return kept;
  return { ...plainFields(fields, SMALLEST_STAND_IN), [flag]: true };
}

// At most maxFields × (key + 6 × stringChars) characters, since escaping can grow a character to six.
function plainFields(
  fields: Array<[string, unknown]>,
  limits: { maxFields: number; stringChars: number; include: (key: string) => boolean },
): Record<string, unknown> {
  const kept: Record<string, unknown> = {};
  let count = 0;
  for (const [field, value] of fields) {
    if (count >= limits.maxFields) break;
    const key = cap(field, STAND_IN_KEY_CHARS);
    if (Object.hasOwn(kept, key) || !limits.include(key)) continue;
    if (typeof value === "string") kept[key] = cap(value, limits.stringChars);
    else if (typeof value === "number" || typeof value === "boolean") kept[key] = value;
    else continue;
    count += 1;
  }
  return kept;
}
