import { createHash } from "node:crypto";
import type { MeetingCalendarEvent } from "@rakazo/adapter-kit";

export type CalendarRule = { scope: string; targetId: string; botId: string | null };

export function matchCalendarRule<T extends CalendarRule>(
  rules: readonly T[],
  event: Pick<MeetingCalendarEvent, "id" | "seriesId">,
) {
  return (
    rules.find((rule) => rule.scope === "event" && rule.targetId === event.id) ??
    rules.find((rule) => rule.scope === "series" && rule.targetId === event.seriesId)
  );
}

export function meetingBookingKey(
  spaceId: string,
  botId: string,
  meetingKey: string,
  startsAt: Date,
) {
  const digest = createHash("sha256")
    .update(JSON.stringify([spaceId, botId, meetingKey, startsAt.toISOString()]))
    .digest("hex");
  return `calendar:${digest}`;
}
