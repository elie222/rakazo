/**
 * Models have no clock. Without an explicit anchor they infer "now" from training data
 * or from timestamps that happen to appear in the conversation, and then reason about
 * deadlines, recency and scheduling from a stale date. Every turn states the real present
 * moment on the user message so that never has to be guessed; it stays out of the system
 * prompt so the cacheable prefix does not change every call.
 */
export function formatCurrentTimeInstruction(now: Date = new Date()): string {
  const iso = now.toISOString().replace(/\.\d{3}Z$/, "Z");
  const weekday = new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: "UTC" }).format(
    now,
  );
  return [
    `Current date and time: ${weekday}, ${iso} (UTC).`,
    "Treat this as the present moment for everything you say and do.",
    "Use it to judge what is past, upcoming, or overdue, convert it to the user's time zone when one is known, and write absolute dates rather than relative ones.",
    "Never infer today's date from your training data or from timestamps quoted in the conversation.",
  ].join(" ");
}
