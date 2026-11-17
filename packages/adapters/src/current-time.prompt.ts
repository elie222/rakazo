/**
 * Models have no clock. Without an explicit anchor they infer "now" from training data
 * or from timestamps that happen to appear in the conversation, and then reason about
 * deadlines, recency and scheduling from a stale date. Every turn states the real present
 * moment on the user message so that never has to be guessed; it stays out of the system
 * prompt so the cacheable prefix does not change every call.
 *
 * With the user's IANA timezone the user's local wall-clock time leads, so "tomorrow
 * morning" and "tonight" mean what the user means; the exact UTC instant stays alongside.
 * An unknown or invalid timezone falls back to UTC only.
 *
 * Replayed history carries no times, so after a pause a model reads its own earlier "it's
 * Wednesday night" as a mistake and corrects it unasked; the anchor says when the chat paused.
 */
export function formatCurrentTimeInstruction(
  now: Date = new Date(),
  timeZone?: string | null,
  previousMessageAt?: Date,
): string {
  const iso = now.toISOString().replace(/\.\d{3}Z$/, "Z");
  const local = timeZone ? localDateTime(now, timeZone) : undefined;
  const anchor = local
    ? `Current date and time for the user: ${local} (${timeZone}). That is ${iso} (UTC).`
    : `Current date and time: ${weekdayIn(now, "UTC")}, ${iso} (UTC).`;
  return [
    anchor,
    previousMessageAt && previousMessageNote(now, previousMessageAt, local ? timeZone : undefined),
    local
      ? "Use the user's time zone for times you mention unless they ask otherwise, judge what is past, upcoming, or overdue from it, and write absolute dates rather than relative ones."
      : "Use it to judge what is past, upcoming, or overdue, convert it to the user's time zone when one is known, and write absolute dates rather than relative ones.",
    "Never infer today's date from your training data or from timestamps quoted in the conversation.",
  ]
    .filter(Boolean)
    .join(" ");
}

const HOUR_MS = 3_600_000;

function previousMessageNote(now: Date, sentAt: Date, timeZone?: string | null) {
  const gap = now.getTime() - sentAt.getTime();
  if (gap < HOUR_MS) return undefined;
  const hours = Math.round(gap / HOUR_MS);
  const when =
    (timeZone && localDateTime(sentAt, timeZone)) ??
    `${weekdayIn(sentAt, "UTC")}, ${sentAt.toISOString().slice(0, 16).replace("T", " ")} (UTC)`;
  const ago =
    hours < 48 ? `${hours} hour${hours === 1 ? "" : "s"}` : `${Math.round(hours / 24)} days`;
  return `The previous message in this chat was sent ${when}, ${ago} earlier. Time passing is not an error in what you said earlier.`;
}

function weekdayIn(now: Date, timeZone: string) {
  return new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone }).format(now);
}

/** "Saturday, 2026-10-17 22:15 (UTC+13:00)", or undefined for an unusable timezone. */
export function localDateTime(now: Date, timeZone: string): string | undefined {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      weekday: "long",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      timeZoneName: "longOffset",
    }).formatToParts(now);
  } catch {
    return undefined;
  }
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((entry) => entry.type === type)?.value ?? "";
  // "GMT+13:00" / "GMT" from longOffset, shown as UTC to match the instant beside it.
  const offset = part("timeZoneName").replace(/^GMT/, "UTC") || "UTC";
  return `${part("weekday")}, ${part("year")}-${part("month")}-${part("day")} ${part("hour")}:${part("minute")} (${offset === "UTC" ? "UTC+00:00" : offset})`;
}
