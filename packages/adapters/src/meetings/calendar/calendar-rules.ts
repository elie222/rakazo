import { createHash } from "node:crypto";
import type { MeetingCalendarEvent } from "@rakazo/adapter-kit";
import type { Prisma } from "@rakazo/db";

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

export async function selectedCalendarRule(
  db: Pick<Prisma.TransactionClient, "meetingCalendarRule">,
  connectionId: string,
  event: MeetingCalendarEvent,
) {
  const rules = await db.meetingCalendarRule.findMany({
    where: {
      connectionId,
      OR: [
        { scope: "event", targetId: event.id },
        ...(event.seriesId ? [{ scope: "series", targetId: event.seriesId }] : []),
      ],
    },
    select: { scope: true, targetId: true, botId: true, shareTranscript: true },
  });
  return matchCalendarRule(rules, event);
}

export async function syncScheduledTranscriptSharing(
  tx: Pick<Prisma.TransactionClient, "meetingSession">,
  owner: { userId: string; spaceId: string },
  id: string,
  shareTranscript: boolean,
) {
  // The session owner's choice governs the recording. Other bookings keep their own choice for a transfer.
  await tx.meetingSession.updateMany({
    where: {
      id,
      userId: owner.userId,
      spaceId: owner.spaceId,
      status: "scheduled",
      receivedAt: null,
      shareTranscript: !shareTranscript,
    },
    data: { shareTranscript },
  });
}
