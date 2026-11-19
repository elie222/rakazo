import { wallClock } from "@rakazo/core";

const DAY_MS = 86_400_000;
const RELATIVE_DAY = /^\{\{today(?:([+-])(\d{1,3})d)?\}\}$/;
/** Tool arguments are a few levels deep; anything nested further is sent as saved. */
const MAX_DEPTH = 8;

/**
 * A change trigger's tool arguments are saved once, so a date written into them goes stale. A
 * string argument that is exactly `{{today}}`, `{{today+2d}}` or `{{today-7d}}` is sent as that
 * calendar day (YYYY-MM-DD) in the routine's timezone, worked out again at every check. Anything
 * else, including text that only contains such a marker, is sent as saved.
 */
export function resolveWatchArgs(
  args: Record<string, unknown>,
  now: Date,
  timezone?: string | null,
): Record<string, unknown> {
  const today = Date.parse(`${wallClock(now, timezone ?? "UTC").slice(0, 10)}T00:00:00Z`);
  const resolve = (value: unknown, depth: number): unknown => {
    if (typeof value === "string") {
      const match = RELATIVE_DAY.exec(value);
      if (!match) return value;
      const days = match[2] ? Number(match[2]) * (match[1] === "-" ? -1 : 1) : 0;
      return new Date(today + days * DAY_MS).toISOString().slice(0, 10);
    }
    if (!value || typeof value !== "object" || depth >= MAX_DEPTH) return value;
    if (Array.isArray(value)) return value.map((item) => resolve(item, depth + 1));
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, resolve(item, depth + 1)]),
    );
  };
  return resolve(args, 0) as Record<string, unknown>;
}
