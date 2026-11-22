import type { MeetingCalendarProvider } from "@rakazo/adapter-kit";
import type { HeldLease, PrismaClient } from "@rakazo/db";
import { withLease } from "@rakazo/db";

/**
 * Removes one calendar booking for a provider that reserves a participant per session.
 * Other calendars may share the session, so the participant is released only with the last
 * booking. Admission holds the same lease while it attaches a calendar to an existing session,
 * so no booking can join the session between this count and the removal.
 */
export async function releaseSessionBooking(
  prisma: PrismaClient,
  provider: MeetingCalendarProvider,
  connectionId: string,
  booking: { eventId: string; sessionId: string },
  lease: HeldLease,
  drop: () => Promise<void>,
) {
  const release = async (signal: AbortSignal) => {
    const [session, others] = await Promise.all([
      prisma.meetingSession.findFirst({
        where: { id: booking.sessionId },
        select: { externalId: true, closedAt: true, status: true },
      }),
      prisma.meetingCalendarBooking.count({
        where: { sessionId: booking.sessionId, NOT: { connectionId, eventId: booking.eventId } },
      }),
    ]);
    const active = session && !session.closedAt && session.status !== "leaving";
    await provider.unschedule(booking.eventId, signal, {
      sessionId: booking.sessionId,
      externalId: session?.externalId ?? null,
      lastBooking: !active || others === 0,
    });
    await drop();
  };
  const owner = await prisma.meetingSession.findFirst({
    where: { id: booking.sessionId },
    select: { spaceId: true },
  });
  if (!owner) return release(lease.signal);
  await withLease(
    prisma,
    `meeting-admission:${owner.spaceId}`,
    { ttlMs: 15_000, signal: lease.signal },
    (admission) => release(admission.signal),
  );
}
