/**
 * Models occasionally pass structured JSON where a string is expected; String() would write
 * "[object Object]", so objects are serialized as readable JSON instead.
 */
export function textContentArg(value: unknown, fallback: string): string {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "object") return JSON.stringify(value, null, 2);
  return String(value);
}

/** How long computer_act waits before observing; a missing (null) or unreadable value is 350. */
export function settleMsArg(value: unknown): number {
  const settleMs = value == null || value === "" ? Number.NaN : Number(value);
  return Number.isFinite(settleMs) ? settleMs : 350;
}
