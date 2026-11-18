import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type {
  JobPublisher,
  MeetingCalendarEvent,
  MeetingCalendarProvider,
  MeetingJoinRequest,
} from "@rakazo/adapter-kit";
import { MeetingCalendarScheduleRejected, RetryJobLaterError } from "@rakazo/adapter-kit";
import type { Actor, MeetingCalendarUpcoming } from "@rakazo/contracts";
import { ClientError, deadlineSignal } from "@rakazo/core";
import type { HeldLease, Prisma, PrismaClient } from "@rakazo/db";
import { assertLeaseHeld, LeaseHeldError, runAsSystem, withLease } from "@rakazo/db";
import { bestEffort } from "@rakazo/logging";
import { parseMeetingUrl } from "../meeting-link.js";
import {
  countSpaceMeetingsForDay,
  MEETING_DAILY_LIMIT,
  MEETING_SESSION_DURATION,
  meetingUtcDayStart,
} from "../meeting-service.js";
import { CalendarAuthorization, signCalendarConnectionRef } from "./calendar-authorization.js";
import {
  matchCalendarRule,
  meetingBookingKey,
  selectedCalendarRule,
  syncScheduledTranscriptSharing,
} from "./calendar-rules.js";

const CONNECT_RECOVERY_MS = 10 * 60_000;
const CONNECT_RETRY_MS = 30_000;
const SYNC_MS = 60_000;
const CLEANUP_MARGIN_MS = 5_000;
const ADMISSION_RECHECK_MS = 2 * 60_000;
const CALENDAR_LOOKAHEAD_MS = 14 * 24 * 60 * 60_000;
const OCCURRENCE_RULE_RETENTION_MS = 7 * 24 * 60 * 60_000;
const CALENDAR_REFRESH_MS = 6 * 60 * 60_000;

type Owner = Pick<Actor, "spaceId" | "userId">;
type Connection = Owner & {
  id: string;
  provider: string;
  externalCalendarId: string | null;
  disconnecting: boolean;
  createdAt: Date;
  eventsDigest: string | null;
};
type Booking = { eventId: string; sessionId: string; startsAt: Date };
type CalendarAction = "once" | "series" | "skip" | "removeSeries";

export interface MeetingCalendarOptions {
  prisma: PrismaClient;
  jobs: JobPublisher;
  provider: MeetingCalendarProvider;
  webOrigin: string;
  enabled: (spaceId: string) => boolean;
  oauthStateKey: string;
  buildJoin: (input: MeetingJoinRequest) => MeetingJoinRequest | Promise<MeetingJoinRequest>;
  publish: (owner: Owner) => Promise<void>;
  now?: () => Date;
}

export class MeetingCalendarService {
  readonly authorization: CalendarAuthorization;

  constructor(private readonly options: MeetingCalendarOptions) {
    this.authorization = new CalendarAuthorization(
      options,
      {
        backup: (connectionId, workMs) => this.backup(connectionId, workMs),
        run: (job) => this.runNow(job),
      },
      () => this.now(),
    );
  }

  available(spaceId: string) {
    return this.options.enabled(spaceId);
  }

  async upcoming(actor: Owner, botId: string): Promise<MeetingCalendarUpcoming> {
    const { provider, prisma } = this.options;
    if (!this.available(actor.spaceId)) {
      return { available: false, connected: false, calendarLabel: "", events: [] };
    }
    const connection = await this.connection(actor);
    const calendar = {
      available: true,
      connected: Boolean(connection?.externalCalendarId && !connection.disconnecting),
      connecting: Boolean(
        connection && !connection.externalCalendarId && !connection.disconnecting,
      ),
      disconnecting: connection?.disconnecting ?? false,
      calendarLabel: provider.calendarLabel,
    };
    if (!connection?.externalCalendarId || connection.disconnecting)
      return { ...calendar, events: [] };

    const events: MeetingCalendarUpcoming["events"] = [];
    const [rules, bookings] = await Promise.all([
      prisma.meetingCalendarRule.findMany({ where: { connectionId: connection.id } }),
      prisma.meetingCalendarBooking.findMany({
        where: { connectionId: connection.id, linked: true },
      }),
    ]);
    const scheduled = new Set(bookings.map((booking) => booking.eventId));
    for await (const event of provider.listEvents(
      connection.externalCalendarId,
      this.upcomingWindow(),
      deadlineSignal(15_000),
    )) {
      const link = this.eligibleLink(event);
      if (!link) continue;
      const rule = matchCalendarRule(rules, event);
      const selection = !rule
        ? "none"
        : !rule.botId
          ? "skipped"
          : rule.botId !== botId
            ? "another_bot"
            : rule.scope === "event"
              ? "once"
              : "series";
      events.push({
        id: event.id,
        title: event.title,
        startsAt: event.startsAt.getTime(),
        endsAt: event.endsAt.getTime(),
        platform: link.platform,
        recurring: event.seriesId !== null,
        selection,
        scheduled: scheduled.has(event.id),
      });
    }
    events.sort((first, second) => first.startsAt - second.startsAt);
    const waiting = (event: (typeof events)[number]) =>
      !event.scheduled && (event.selection === "once" || event.selection === "series");
    const days = new Set(
      events.filter(waiting).map(({ startsAt }) => meetingUtcDayStart(startsAt)),
    );
    const fullDays = new Set<number>();
    if (days.size) {
      await runAsSystem("read meeting quota for selected calendar events", async () => {
        await Promise.all(
          [...days].map(async (day) => {
            if (
              (await countSpaceMeetingsForDay(prisma, actor.spaceId, new Date(day))) >=
              MEETING_DAILY_LIMIT
            ) {
              fullDays.add(day);
            }
          }),
        );
      });
    }
    return {
      ...calendar,
      events: events.map((event) => ({
        ...event,
        quotaReached: waiting(event) && fullDays.has(meetingUtcDayStart(event.startsAt)),
      })),
    };
  }

  async updateSelection(
    actor: Owner,
    botId: string,
    eventId: string,
    action: CalendarAction,
    shareTranscript = false,
  ) {
    this.requireEnabled(actor.spaceId);
    const { prisma, provider } = this.options;
    const connection = await this.connection(actor);
    if (!connection?.externalCalendarId || connection.disconnecting) {
      throw new ClientError("CONFLICT", "Connect a calendar first.");
    }
    const event = await provider.getEvent(eventId, deadlineSignal(10_000));
    if (!event || event.calendarId !== connection.externalCalendarId || !this.eligibleLink(event)) {
      throw new ClientError("NOT_FOUND", "This calendar meeting is no longer available.");
    }
    const scope = action === "series" || action === "removeSeries" ? "series" : "event";
    const targetId = scope === "series" ? event.seriesId : event.id;
    if (!targetId) throw new ClientError("BAD_REQUEST", "This meeting does not repeat.");

    const backup = this.backup(connection.id);
    await prisma.$transaction(async (tx) => {
      // Lock this connection's row while recording the user's choices, so disconnect
      // and concurrent selections cannot leave rules on a calendar just removed.
      if (!(await this.lockConnectedCalendar(tx, connection.id)))
        throw new ClientError("CONFLICT", "This calendar is disconnecting.");
      if (action === "removeSeries") {
        await tx.meetingCalendarRule.deleteMany({
          where: {
            connectionId: connection.id,
            botId,
            OR: [
              { scope, targetId },
              { scope: "event", seriesId: targetId },
            ],
          },
        });
      } else {
        const selected = {
          botId: action === "skip" ? null : botId,
          shareTranscript: action !== "skip" && shareTranscript,
          eventStartsAt: scope === "event" ? event.startsAt : null,
          seriesId: scope === "event" ? event.seriesId : null,
        };
        await tx.meetingCalendarRule.upsert({
          where: { connectionId_scope_targetId: { connectionId: connection.id, scope, targetId } },
          create: {
            connectionId: connection.id,
            scope,
            targetId,
            ...selected,
          },
          update: selected,
        });
        // Re-enable the visible instance when a series is selected from a skipped occurrence.
        if (action === "series") {
          await tx.meetingCalendarRule.deleteMany({
            where: { connectionId: connection.id, scope: "event", targetId: event.id },
          });
        }
      }
      await this.options.jobs.enqueueIn(tx, backup);
    });
    await bestEffort("reconcile meeting calendar", this.runNow(backup));
  }

  async disconnect(actor: Owner) {
    const connection = await this.connection(actor);
    if (!connection) return;
    const backup = this.backup(connection.id);
    await this.options.prisma.$transaction(async (tx) => {
      await tx.meetingCalendarConnection.updateMany({
        where: { id: connection.id },
        data: { disconnecting: true },
      });
      await this.options.jobs.enqueueIn(tx, backup);
    });
    await bestEffort("reconcile meeting calendar", this.runNow(backup));
  }

  disconnectUser(userId: string) {
    return this.disconnectScope({ userId });
  }

  disconnectOwner({ spaceId, userId }: Owner) {
    return this.disconnectScope({ spaceId, userId });
  }

  disconnectSpace(spaceId: string) {
    return this.disconnectScope({ spaceId });
  }

  private async disconnectScope(scope: { spaceId: string; userId?: string } | { userId: string }) {
    const { prisma, jobs, provider } = this.options;
    const backups = await runAsSystem(
      "remove calendar access when its owner or Space loses access",
      () =>
        prisma.$transaction(async (tx) => {
          const rows = await tx.meetingCalendarConnection.updateManyAndReturn({
            where: { ...scope, provider: provider.id },
            data: { disconnecting: true },
            select: { id: true },
          });
          const pending = rows.map(({ id }) => ({
            ...this.backup(id),
            // This key also identifies the backup written by the member-departure trigger.
            replaceKey: `meeting-calendar:disconnect:${id}`,
          }));
          if (pending.length) await jobs.enqueueManyIn(tx, pending);
          return pending;
        }),
    );
    // Keep provider handles available until sync confirms the disconnect.
    const outcomes = await Promise.allSettled(backups.map((backup) => this.runNow(backup)));
    for (const outcome of outcomes) {
      if (outcome.status === "rejected") throw outcome.reason;
    }
  }

  verifyChange(body: string, headers: Headers) {
    return this.options.provider.verifyChange(body, headers);
  }

  async providerChanged(calendarId: string) {
    await runAsSystem("route signed calendar update to its owner", async () => {
      const { provider, prisma } = this.options;
      let connection = await prisma.meetingCalendarConnection.findFirst({
        where: { provider: provider.id, externalCalendarId: calendarId },
      });
      if (!connection) {
        const signal = deadlineSignal(8_000);
        const remote = await provider.getConnection(calendarId, signal);
        const id = this.matchConnectionRef(remote?.connectionRef);
        if (!remote || !id) return;
        connection = await prisma.meetingCalendarConnection.findFirst({
          where: { id, provider: provider.id, externalCalendarId: null },
        });
        if (!connection) {
          // An authenticated callback can report a resource accepted after its
          // local recovery window. The signed reference proves it is ours.
          const alreadyBound = await prisma.meetingCalendarConnection.findFirst({
            where: { id, provider: provider.id, externalCalendarId: calendarId },
          });
          if (!alreadyBound) await provider.disconnect(calendarId, signal);
          return;
        }
      }
      const backup = this.backup(connection.id);
      await this.options.jobs.enqueue(backup);
      void bestEffort(
        "reconcile meeting calendar",
        this.runNow(backup, { coalesceWhenBusy: true }),
      );
    });
  }

  async sync(connectionId: string) {
    const { prisma, provider } = this.options;
    await runAsSystem("reconcile scheduled meetings for an owned calendar", () =>
      withLease(
        prisma,
        `meeting-calendar:${connectionId}`,
        { ttlMs: 30_000, signal: deadlineSignal(SYNC_MS) },
        async (lease) => {
          const connection = await prisma.meetingCalendarConnection.findFirst({
            where: { id: connectionId, provider: provider.id },
            include: { rules: true, bookings: true },
          });
          if (!connection) return;
          const recovered = connection.externalCalendarId
            ? null
            : await this.recoverConnection(connection, lease);
          const calendarId = connection.externalCalendarId ?? recovered?.calendarId;
          if (!calendarId) return;

          const member = await prisma.spaceMember.findFirst({
            where: {
              spaceId: connection.spaceId,
              userId: connection.userId,
              member: { user: { deactivatedAt: null } },
              space: { deletionClaimId: null },
            },
          });
          const status =
            connection.disconnecting || !member || !this.options.enabled(connection.spaceId)
              ? "disconnected"
              : (recovered?.status ??
                (await provider.getConnection(calendarId, lease.signal))?.status);
          if (
            status === "connecting" &&
            this.now().getTime() - connection.createdAt.getTime() < CONNECT_RECOVERY_MS
          ) {
            throw new RetryJobLaterError(CONNECT_RETRY_MS);
          }
          if (status !== "connected") {
            await provider.disconnect(calendarId, deadlineSignal(12_000, lease.signal));
            await prisma.$transaction(async (tx) => {
              await assertLeaseHeld(tx, lease);
              await tx.meetingCalendarConnection.deleteMany({ where: { id: connectionId } });
              for (const booking of connection.bookings)
                await this.reconcileBookingOwner(tx, booking.sessionId);
            });
            await this.options.publish(connection);
            return;
          }

          await this.scheduleCalendarRefresh(connectionId);
          const window = this.upcomingWindow();
          const events = [];
          let retryCancellation: unknown;
          for await (const event of provider.listEvents(calendarId, window, lease.signal))
            events.push(event);

          const bookings = new Map(
            connection.bookings.map((booking) => [booking.eventId, booking]),
          );
          for (const event of events) {
            const previous = bookings.get(event.id);
            bookings.delete(event.id);
            const rule =
              previous || matchCalendarRule(connection.rules, event)?.botId
                ? await selectedCalendarRule(prisma, connectionId, event)
                : null;
            const link = this.eligibleLink(event, window);
            const bot = rule?.botId
              ? await prisma.bot.findFirst({
                  where: { id: rule.botId, spaceId: connection.spaceId, archivedAt: null },
                  select: { id: true, name: true },
                })
              : null;
            if (rule && bot && link && event.meetingUrl) {
              lease.signal.throwIfAborted();
              // A valid reservation that started during this pass can already be joining.
              if (event.startsAt <= this.now()) continue;
              const key = meetingBookingKey(connection.spaceId, bot.id, link.key, event.startsAt);
              const expiresAt = new Date(event.startsAt.getTime() + MEETING_SESSION_DURATION);
              const configDigest = createHmac("sha256", this.options.oauthStateKey)
                .update(JSON.stringify([link.url, bot.name, event.startsAt.toISOString()]))
                .digest("base64url");
              const reservation = { configDigest, expiresAt, key };
              if (previous) {
                const prior = await prisma.meetingSession.findFirst({
                  where: { id: previous.sessionId },
                  select: { activeKey: true, closedAt: true, status: true },
                });
                if (!prior || prior.closedAt || prior.status === "leaving") {
                  await this.cancelBooking(connectionId, previous, event, bot.id, lease);
                  continue;
                }
                if (
                  prior.activeKey === key &&
                  previous.linked &&
                  previous.configDigest === configDigest
                ) {
                  if (previous.shareTranscript !== rule.shareTranscript)
                    await this.reserve(
                      connection,
                      event,
                      bot.id,
                      link.platform,
                      { ...reservation, linkedSessionId: previous.sessionId },
                      lease,
                    );
                  continue;
                }
                if (prior.activeKey !== key)
                  await this.removeBooking(connectionId, previous, lease);
              }

              const sessionId = await this.reserve(
                connection,
                event,
                bot.id,
                link.platform,
                reservation,
                lease,
              );
              if (!sessionId) continue;

              const booking = { eventId: event.id, sessionId, startsAt: event.startsAt };
              const request = await this.options.buildJoin({
                sessionId,
                meetingUrl: link.url,
                platform: link.platform,
                botName: `${bot.name.slice(0, 88)} · Rakazo`,
                expiresAt,
              });
              if ((await selectedCalendarRule(prisma, connectionId, event))?.botId !== bot.id) {
                await this.removeBooking(connectionId, booking, lease);
                continue;
              }
              let externalId: string;
              try {
                externalId = await provider.schedule(
                  event.id,
                  key,
                  event.startsAt,
                  request,
                  lease.signal,
                );
              } catch (error) {
                if (!(error instanceof MeetingCalendarScheduleRejected)) throw error;
                await this.cancelBooking(connectionId, booking, event, bot.id, lease).catch(
                  (error: unknown) => {
                    // Give the other events a chance to sync before retrying cancellation.
                    retryCancellation ??= error;
                  },
                );
                continue;
              }
              const cancelled = await prisma.$transaction(async (tx) => {
                await assertLeaseHeld(tx, lease);
                const connected = await this.lockConnectedCalendar(tx, connectionId);
                await tx.$queryRaw`SELECT id FROM meeting_sessions WHERE id = ${sessionId} FOR UPDATE`;
                const session = await tx.meetingSession.findFirst({
                  where: { id: sessionId },
                  select: { externalId: true, closedAt: true, status: true },
                });
                if (session && !session.externalId) {
                  await tx.meetingSession.update({
                    where: { id: sessionId },
                    data: { externalId },
                  });
                }
                const selected =
                  connected &&
                  (await selectedCalendarRule(tx, connectionId, event))?.botId === bot.id;
                if (!session || session.closedAt || session.status === "leaving" || !selected) {
                  // Keep the provider ID for cleanup when a leave or selection change wins.
                  // Wake the other calendars if the reservation was shared.
                  const others = await tx.meetingCalendarBooking.findMany({
                    where: { sessionId, connectionId: { not: connectionId } },
                    distinct: ["connectionId"],
                    select: { connectionId: true },
                  });
                  await this.options.jobs.enqueueManyIn(
                    tx,
                    others.map(({ connectionId }) => ({
                      ...this.backup(connectionId),
                      availableAt: this.now(),
                    })),
                  );
                  if (session?.status === "leaving" && !session.closedAt) {
                    await this.options.jobs.enqueueIn(tx, {
                      name: "meeting.work",
                      payload: { sessionId, action: "leave" },
                      availableAt: this.now(),
                      replaceKey: `meeting:${sessionId}:leave`,
                      queueName: `meeting:${sessionId}`,
                    });
                  }
                  return selected ? "closed" : "selection-changed";
                }
                await tx.meetingCalendarBooking.update({
                  where: { connectionId_eventId: { connectionId, eventId: event.id } },
                  data: { linked: true },
                });
                await this.reconcileBookingOwner(tx, sessionId);
                const availableAt = new Date(event.startsAt.getTime() - ADMISSION_RECHECK_MS);
                if (availableAt > this.now()) {
                  await this.options.jobs.enqueueIn(tx, {
                    name: "meeting.calendar-sync",
                    payload: { connectionId },
                    availableAt,
                    replaceKey: `meeting-calendar:recheck:${connectionId}:${event.id}`,
                    queueName: `meeting-calendar:${connectionId}`,
                  });
                }
                return null;
              });
              if (cancelled === "closed")
                await this.cancelBooking(connectionId, booking, event, bot.id, lease);
              if (cancelled === "selection-changed")
                await this.removeBooking(connectionId, booking, lease);
            } else if (previous) {
              await this.removeBooking(connectionId, previous, lease);
            }
          }
          const past: string[] = [];
          for (const booking of bookings.values()) {
            if (booking.startsAt > this.now())
              await this.removeBooking(connectionId, booking, lease);
            else past.push(booking.sessionId);
          }
          if (past.length) {
            await prisma.$transaction(async (tx) => {
              await assertLeaseHeld(tx, lease);
              const unfinished = await tx.meetingSession.findMany({
                where: { id: { in: past }, closedAt: null },
                select: { id: true },
              });
              await tx.meetingCalendarBooking.deleteMany({
                where: {
                  connectionId,
                  sessionId: { in: past, notIn: unfinished.map(({ id }) => id) },
                },
              });
            });
          }
          await this.publishChanges(connection, events, lease);
          await this.pruneOccurrenceRules(connectionId, calendarId, connection.rules, lease);
          if (retryCancellation) throw retryCancellation;
        },
      ),
    );
  }

  private async pruneOccurrenceRules(
    connectionId: string,
    calendarId: string,
    rules: { scope: string; targetId: string; eventStartsAt: Date | null }[],
    lease: HeldLease,
  ) {
    const { prisma, provider } = this.options;
    const cutoff = new Date(this.now().getTime() - OCCURRENCE_RULE_RETENTION_MS);
    const stale = rules
      .filter(
        ({ scope, eventStartsAt }) =>
          scope === "event" && (!eventStartsAt || eventStartsAt < cutoff),
      )
      .slice(0, 10);
    for (const { scope, targetId, eventStartsAt } of stale) {
      lease.signal.throwIfAborted();
      const event = await bestEffort(
        "check an old meeting calendar occurrence",
        provider.getEvent(targetId, deadlineSignal(5_000, lease.signal)),
      );
      if (event === undefined) continue;
      const where = { connectionId, scope, targetId, eventStartsAt };
      await prisma.$transaction(async (tx) => {
        await assertLeaseHeld(tx, lease);
        if (
          event &&
          event.calendarId === calendarId &&
          !event.cancelled &&
          event.startsAt >= cutoff
        ) {
          await tx.meetingCalendarRule.updateMany({
            where,
            data: { eventStartsAt: event.startsAt },
          });
        } else {
          await tx.meetingCalendarRule.deleteMany({ where });
        }
      });
    }
  }

  private async scheduleCalendarRefresh(connectionId: string) {
    // Sparse backup for missed webhooks, with a stable per-calendar phase so
    // all connections on a deployment do not refresh together.
    const phase =
      createHash("sha256").update(connectionId).digest().readUInt32BE() % CALENDAR_REFRESH_MS;
    const after = this.now().getTime() + 60_000;
    const time = Math.ceil((after - phase) / CALENDAR_REFRESH_MS) * CALENDAR_REFRESH_MS + phase;
    await this.options.jobs.enqueue({
      ...this.backup(connectionId),
      availableAt: new Date(time),
      replaceKey: `meeting-calendar:refresh:${connectionId}:${time}`,
      keepExisting: true,
    });
  }

  private async recoverConnection(connection: Connection, lease: HeldLease) {
    const { provider, prisma } = this.options;
    const remote = await provider.findConnection(
      signCalendarConnectionRef(this.options.oauthStateKey, connection.id),
      new Date(connection.createdAt.getTime() - CONNECT_RETRY_MS),
      lease.signal,
    );
    if (remote) {
      await prisma.$transaction(async (tx) => {
        await assertLeaseHeld(tx, lease);
        await tx.meetingCalendarConnection.update({
          where: { id: connection.id },
          data: { externalCalendarId: remote.calendarId },
        });
      });
      return remote;
    }
    if (this.now().getTime() - connection.createdAt.getTime() < CONNECT_RECOVERY_MS) {
      throw new RetryJobLaterError(CONNECT_RETRY_MS);
    }

    // A definite negative lookup after the recovery window lets the user start
    // a new authorization. A late provider webhook still cleans up this attempt.
    await prisma.$transaction(async (tx) => {
      await assertLeaseHeld(tx, lease);
      await tx.meetingCalendarConnection.deleteMany({
        where: { id: connection.id, externalCalendarId: null },
      });
    });
    await this.options.publish(connection);
    return null;
  }

  private async publishChanges(
    connection: Connection,
    events: readonly MeetingCalendarEvent[],
    lease: HeldLease,
  ) {
    const { prisma } = this.options;
    const [rules, bookings] = await Promise.all([
      prisma.meetingCalendarRule.findMany({
        where: { connectionId: connection.id },
        orderBy: [{ scope: "asc" }, { targetId: "asc" }],
        select: { scope: true, targetId: true, botId: true },
      }),
      prisma.meetingCalendarBooking.findMany({
        where: { connectionId: connection.id, linked: true },
        orderBy: { eventId: "asc" },
        select: { eventId: true },
      }),
    ]);
    const visible = events
      .filter((event) => this.eligibleLink(event))
      .sort((first, second) => first.id.localeCompare(second.id));
    const digest = createHmac("sha256", this.options.oauthStateKey)
      .update(JSON.stringify([visible, rules, bookings]))
      .digest("base64url");
    if (connection.eventsDigest === digest) return;

    // Save the digest after publishing so the durable retry will send the signal
    // again if publishing fails following a committed calendar update.
    await this.options.publish(connection);
    await prisma.$transaction(async (tx) => {
      await assertLeaseHeld(tx, lease);
      await tx.meetingCalendarConnection.updateMany({
        where: { id: connection.id },
        data: { eventsDigest: digest },
      });
    });
  }

  private async reserve(
    connection: Connection,
    event: MeetingCalendarEvent,
    botId: string,
    platform: MeetingJoinRequest["platform"],
    {
      configDigest,
      expiresAt,
      key,
      linkedSessionId,
    }: {
      expiresAt: Date;
      configDigest: string;
      key: string;
      linkedSessionId?: string;
    },
    lease: HeldLease,
  ) {
    const { prisma, provider } = this.options;
    const { id: eventId, startsAt } = event;
    return withLease(
      prisma,
      `meeting-admission:${connection.spaceId}`,
      { ttlMs: 15_000, signal: lease.signal },
      (admission) =>
        prisma.$transaction(async (tx) => {
          await assertLeaseHeld(tx, lease);
          await assertLeaseHeld(tx, admission);
          if (!(await this.lockConnectedCalendar(tx, connection.id))) return null;
          const rule = await selectedCalendarRule(tx, connection.id, event);
          if (rule?.botId !== botId) return null;
          const { shareTranscript } = rule;
          // Reserve the link with the session. Last-unlink cleanup locks the same
          // session row and keeps it while another calendar is being attached.
          const [existing] = await tx.$queryRaw<{ id: string; status: string }[]>`
            SELECT id, status FROM meeting_sessions WHERE "activeKey" = ${key} FOR UPDATE
          `;
          if (linkedSessionId && existing?.id !== linkedSessionId) return null;
          if (existing?.status === "leaving") {
            await this.recordSkippedEvent(tx, connection.id, eventId, startsAt);
            return null;
          }
          if (
            !existing &&
            (await countSpaceMeetingsForDay(tx, connection.spaceId, startsAt)) >=
              MEETING_DAILY_LIMIT
          ) {
            return null;
          }
          const id = existing?.id ?? randomUUID();
          if (existing) await syncScheduledTranscriptSharing(tx, connection, id, shareTranscript);
          if (!existing) {
            await tx.meetingSession.create({
              data: {
                id,
                spaceId: connection.spaceId,
                userId: connection.userId,
                botId,
                provider: provider.id,
                platform,
                status: "scheduled",
                shareTranscript,
                activeKey: key,
                expiresAt,
                scheduledFor: startsAt,
                // If a scheduling response is lost, expiry may reconcile by metadata.
                requestedAt: this.now(),
              },
            });
            await this.options.jobs.enqueueIn(tx, {
              name: "meeting.work",
              payload: { sessionId: id, action: "expire" },
              availableAt: expiresAt,
              replaceKey: `meeting:${id}:expire`,
              queueName: `meeting:${id}`,
            });
          }
          await tx.meetingCalendarBooking.upsert({
            where: { connectionId_eventId: { connectionId: connection.id, eventId } },
            create: {
              connectionId: connection.id,
              eventId,
              sessionId: id,
              startsAt,
              configDigest,
              shareTranscript,
            },
            update: {
              sessionId: id,
              startsAt,
              configDigest,
              linked: Boolean(linkedSessionId),
              shareTranscript,
            },
          });
          return id;
        }),
    );
  }

  private async lockConnectedCalendar(tx: Prisma.TransactionClient, connectionId: string) {
    const [row] = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM meeting_calendar_connections
      WHERE id = ${connectionId} AND NOT disconnecting
      FOR UPDATE
    `;
    return Boolean(row);
  }

  private async cancelBooking(
    connectionId: string,
    booking: Booking,
    event: MeetingCalendarEvent,
    botId: string,
    lease: HeldLease,
  ) {
    await this.options.prisma.$transaction(async (tx) => {
      await assertLeaseHeld(tx, lease);
      if (
        (await this.lockConnectedCalendar(tx, connectionId)) &&
        (await selectedCalendarRule(tx, connectionId, event))?.botId === botId
      )
        await this.recordSkippedEvent(tx, connectionId, booking.eventId, booking.startsAt);
    });
    // A rejected update may leave an earlier provider booking intact, even if
    // this attempt had cleared its local linked flag.
    await this.removeBooking(connectionId, booking, lease);
  }

  private recordSkippedEvent(
    tx: Prisma.TransactionClient,
    connectionId: string,
    eventId: string,
    eventStartsAt: Date,
  ) {
    const rule = { connectionId, scope: "event", targetId: eventId };
    return tx.meetingCalendarRule.upsert({
      where: { connectionId_scope_targetId: rule },
      create: { ...rule, botId: null, eventStartsAt },
      update: { botId: null, eventStartsAt },
    });
  }

  private async removeBooking(connectionId: string, booking: Booking, lease: HeldLease) {
    await this.options.provider.unschedule(booking.eventId, lease.signal);
    await this.dropBooking(connectionId, booking, lease);
  }

  private async dropBooking(connectionId: string, booking: Booking, lease: HeldLease) {
    await this.options.prisma.$transaction(async (tx) => {
      await assertLeaseHeld(tx, lease);
      await tx.meetingCalendarBooking.deleteMany({
        where: { connectionId, eventId: booking.eventId },
      });
      await this.reconcileBookingOwner(tx, booking.sessionId);
    });
  }

  private async reconcileBookingOwner(tx: Prisma.TransactionClient, sessionId: string) {
    await tx.$queryRaw`SELECT id FROM meeting_sessions WHERE id = ${sessionId} FOR UPDATE`;
    const session = await tx.meetingSession.findFirst({
      where: { id: sessionId, status: "scheduled", receivedAt: null },
      select: { userId: true, spaceId: true },
    });
    if (!session) return;
    const remaining = await tx.meetingCalendarBooking.findMany({
      where: { sessionId },
      orderBy: [{ connectionId: "asc" }, { eventId: "asc" }],
      select: {
        linked: true,
        shareTranscript: true,
        connection: { select: { userId: true, spaceId: true, disconnecting: true } },
      },
    });
    if (!remaining.length) {
      await tx.meetingSession.update({
        where: { id: sessionId },
        data: { status: "ended", activeKey: null, closedAt: this.now() },
      });
      return;
    }

    // Transfer only before any provider observation or captured content, and only
    // to an active member who already booked this same provider bot.
    const bookers = remaining
      .filter(
        ({ linked, connection }) =>
          linked && !connection.disconnecting && connection.spaceId === session.spaceId,
      )
      .map(({ connection, shareTranscript }) => ({ userId: connection.userId, shareTranscript }));
    if (bookers.some(({ userId }) => userId === session.userId)) return;
    const members = await tx.spaceMember.findMany({
      where: {
        spaceId: session.spaceId,
        userId: { in: bookers.map(({ userId }) => userId) },
        member: { user: { deactivatedAt: null } },
      },
      select: { userId: true },
    });
    const active = new Set(members.map(({ userId }) => userId));
    const owner = bookers.find(({ userId }) => active.has(userId));
    if (owner) {
      await tx.meetingSession.update({ where: { id: sessionId }, data: owner });
    }
  }

  private connection({ spaceId, userId }: Owner): Promise<Connection | null> {
    return this.options.prisma.meetingCalendarConnection.findFirst({
      where: { spaceId, userId, provider: this.options.provider.id },
    });
  }

  private upcomingWindow() {
    const upcoming = this.now();
    return { upcoming, startsThrough: new Date(upcoming.getTime() + CALENDAR_LOOKAHEAD_MS) };
  }

  private eligibleLink(
    event: MeetingCalendarEvent,
    { upcoming, startsThrough } = this.upcomingWindow(),
  ) {
    if (
      event.cancelled ||
      event.declined ||
      event.startsAt <= upcoming ||
      event.startsAt > startsThrough ||
      event.endsAt <= event.startsAt ||
      !event.meetingUrl
    )
      return null;
    try {
      return parseMeetingUrl(event.meetingUrl);
    } catch (error) {
      if (error instanceof ClientError) return null;
      throw error;
    }
  }

  private requireEnabled(spaceId: string) {
    if (!this.options.enabled(spaceId)) {
      throw new ClientError("FORBIDDEN", "Calendar scheduling is unavailable in this Space.");
    }
  }

  private matchConnectionRef(ref?: string) {
    const id = ref?.split(".", 1)[0];
    if (!id || !ref || !/^[0-9a-f-]{36}$/u.test(id)) return null;
    const expected = Buffer.from(signCalendarConnectionRef(this.options.oauthStateKey, id));
    const received = Buffer.from(ref);
    return expected.length === received.length && timingSafeEqual(expected, received) ? id : null;
  }

  private backup(connectionId: string, workMs = SYNC_MS) {
    return {
      name: "meeting.calendar-sync" as const,
      payload: { connectionId },
      queueName: `meeting-calendar:${connectionId}`,
      replaceKey: `meeting-calendar:${randomUUID()}`,
      availableAt: new Date(this.now().getTime() + workMs + CLEANUP_MARGIN_MS),
    };
  }

  private async runNow(
    backup: ReturnType<MeetingCalendarService["backup"]>,
    { coalesceWhenBusy = false } = {},
  ) {
    try {
      await this.sync(backup.payload.connectionId);
    } catch (error) {
      if (coalesceWhenBusy && error instanceof LeaseHeldError) {
        // Keep the request's own backup until the shared catch-up is durable.
        // The running sync must only cancel its own backup.
        const { connectionId } = backup.payload;
        await this.options.jobs.enqueue({
          ...backup,
          replaceKey: `meeting-calendar:webhook-recheck:${connectionId}`,
          availableAt: new Date(this.now().getTime() + CONNECT_RETRY_MS),
        });
        await this.options.jobs.cancel(backup.replaceKey);
        return;
      }
      const delay =
        error instanceof RetryJobLaterError
          ? error.delayMs
          : error instanceof LeaseHeldError
            ? CONNECT_RETRY_MS
            : 0;
      await this.options.jobs.enqueue({
        ...backup,
        availableAt: new Date(this.now().getTime() + delay),
      });
      throw error;
    }
    await this.options.jobs.cancel(backup.replaceKey);
  }

  private now() {
    return this.options.now?.() ?? new Date();
  }
}
