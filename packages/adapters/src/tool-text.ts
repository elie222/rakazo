/**
 * Coerce a tool-call argument into text for file-writing tools.
 *
 * Models occasionally pass structured JSON where a string is expected
 * (e.g. write_file content). String() on an object yields "[object Object]",
 * which would silently corrupt the written file — serialise objects to
 * readable JSON instead.
 */
export function textContentArg(value: unknown, fallback: string): string {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "object") return JSON.stringify(value, null, 2);
  return String(value);
}
