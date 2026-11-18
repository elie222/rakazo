import { createHash, createHmac, randomUUID } from "node:crypto";
import type {
  JobPublisher,
  MeetingCalendarEvent,
  MeetingCalendarProvider,
  MeetingJoinRequest,
} from "@rakazo/adapter-kit";
import { RetryJobLaterError } from "@rakazo/adapter-kit";
import type { Actor, RpcOutput } from "@rakazo/contracts";
import { MEETING_CALENDAR_CALLBACK_PATH } from "@rakazo/contracts";
import { ClientError, deadlineSignal } from "@rakazo/core";
import type { HeldLease, Prisma, PrismaClient } from "@rakazo/db";
import { assertLeaseHeld, runAsSystem, runAsTenant, withLease } from "@rakazo/db";
import { bestEffort } from "@rakazo/logging";
import {
  MEETING_DAILY_LIMIT,
  MEETING_SESSION_DURATION,
  parseMeetingUrl,
} from "../meeting-service.js";
import { matchCalendarRule, meetingBookingKey } from "./calendar-rules.js";

const OAUTH_SESSION_MS = 10 * 60_000;
const SYNC_MS = 60_000;
const CLEANUP_MARGIN_MS = 5_000;
const ADMISSION_RECHECK_MS = 2 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

type Owner = Pick<Actor, "spaceId" | "userId">;
type Connection = Owner & {
  id: string;
  provider: string;
  externalCalendarId: string | null;
  disconnecting: boolean;
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
  constructor(private readonly options: MeetingCalendarOptions) {}

  async upcoming(actor: Owner, botId: string): Promise<RpcOutput<"meetingCalendar/upcoming">> {
    const { provider, prisma } = this.options;
    if (!this.options.enabled(actor.spaceId)) {
      return { available: false, connected: false, calendarLabel: "", events: [] };
    }
    const connection = await this.connection(actor);
    const calendar = {
      available: true,
      connected: Boolean(connection?.externalCalendarId && !connection.disconnecting),
      calendarLabel: provider.calendarLabel,
    };
    if (!connection?.externalCalendarId || connection.disconnecting)
      return { ...calendar, events: [] };

    const events = [];
    const [rules, bookings] = await Promise.all([
      prisma.meetingCalendarRule.findMany({ where: { connectionId: connection.id } }),
      prisma.meetingCalendarBooking.findMany({
        where: { connectionId: connection.id, linked: true },
      }),
    ]);
    const scheduled = new Set(bookings.map((booking) => booking.eventId));
    for await (const event of provider.listEvents(
      connection.externalCalendarId,
      { upcoming: this.now() },
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
      } as const);
    }
    events.sort((first, second) => first.startsAt - second.startsAt);
    return { ...calendar, events };
  }

  async begin({ spaceId, userId }: Owner, client: "web" | "mobile") {
    this.requireEnabled(spaceId);
    const { prisma, provider, webOrigin } = this.options;
    if (await this.connection({ spaceId, userId })) {
      throw new ClientError(
        "CONFLICT",
        "Disconnect the current calendar before connecting another.",
      );
    }
    const state = `${client}-${randomUUID()}`;
    await prisma.meetingCalendarAuthorization.upsert({
      where: { spaceId_userId: { spaceId, userId } },
      create: {
        spaceId,
        userId,
        id: state,
        expiresAt: new Date(this.now().getTime() + OAUTH_SESSION_MS),
      },
      update: { id: state, expiresAt: new Date(this.now().getTime() + OAUTH_SESSION_MS) },
    });
    const challenge = createHash("sha256").update(this.verifier(state)).digest("base64url");
    return {
      state,
      authorizationUrl: provider.authorizationUrl({
        state,
        challenge,
        redirectUri: this.redirectUri(webOrigin),
      }),
    };
  }

  async completeFromBrowser(userId: string, state: string, code: string) {
    const owner = await runAsSystem(
      "find an authorization belonging to the signed-in calendar user",
      async () => {
        const authorization = await this.options.prisma.meetingCalendarAuthorization.findFirst({
          where: { id: state, userId, expiresAt: { gt: this.now() } },
          select: { spaceId: true, userId: true },
        });
        if (!authorization) return null;
        const member = await this.options.prisma.spaceMember.findUnique({
          where: { spaceId_userId: authorization },
          select: { id: true },
        });
        return member ? authorization : null;
      },
    );
    if (!owner) throw new ClientError("BAD_REQUEST", "Start the calendar sign-in again.");
    await runAsTenant(owner, () => this.complete(owner, state, code));
  }

  async complete(actor: Owner, state: string, code: string) {
    this.requireEnabled(actor.spaceId);
    const { prisma, provider, webOrigin } = this.options;
    const scope = { spaceId: actor.spaceId, userId: actor.userId };
    const connectionId = randomUUID();
    const reserved = await prisma.$transaction(async (tx) => {
      const consumed = await tx.meetingCalendarAuthorization.deleteMany({
        where: { ...scope, id: state, expiresAt: { gt: this.now() } },
      });
      if (!consumed.count)
        throw new ClientError("BAD_REQUEST", "Start the calendar sign-in again.");
      const connection = await tx.meetingCalendarConnection.findUnique({
        where: { spaceId_userId: scope },
      });
      if (connection)
        throw new ClientError("CONFLICT", "A calendar is already connected in this Space.");
      return tx.meetingCalendarConnection.create({
        data: { ...scope, id: connectionId, provider: provider.id },
      });
    });
    const { calendarId } = await provider
      .connect(
        {
          connectionId: reserved.id,
          code,
          verifier: this.verifier(state),
          redirectUri: this.redirectUri(webOrigin),
        },
        deadlineSignal(20_000),
      )
      .catch(async (error: unknown) => {
        await prisma.meetingCalendarConnection.deleteMany({
          where: { id: reserved.id, externalCalendarId: null },
        });
        throw error;
      });
    await prisma.meetingCalendarConnection.update({
      where: { id: reserved.id },
      data: { externalCalendarId: calendarId },
    });
    await this.options.publish(scope);
  }

  async updateSelection(actor: Owner, botId: string, eventId: string, action: CalendarAction) {
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
      if (
        !(
          await tx.meetingCalendarConnection.updateMany({
            where: { id: connection.id, disconnecting: false },
            data: { disconnecting: false },
          })
        ).count
      )
        throw new ClientError("CONFLICT", "This calendar is disconnecting.");
      if (action === "removeSeries") {
        await tx.meetingCalendarRule.deleteMany({
          where: { connectionId: connection.id, scope, targetId, botId },
        });
      } else {
        const selected = action === "skip" ? null : botId;
        await tx.meetingCalendarRule.upsert({
          where: { connectionId_scope_targetId: { connectionId: connection.id, scope, targetId } },
          create: { connectionId: connection.id, scope, targetId, botId: selected },
          update: { botId: selected },
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

  verifyChange(body: string, headers: Headers) {
    return this.options.provider.verifyChange(body, headers);
  }

  async providerChanged(calendarId: string) {
    await runAsSystem("route signed calendar update to its owner", async () => {
      const connection = await this.options.prisma.meetingCalendarConnection.findFirst({
        where: { provider: this.options.provider.id, externalCalendarId: calendarId },
      });
      if (!connection) return;
      const backup = this.backup(connection.id);
      await this.options.jobs.enqueue(backup);
      void bestEffort("reconcile meeting calendar", this.runNow(backup));
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
          if (!connection.externalCalendarId) return;

          const member = await prisma.spaceMember.findFirst({
            where: {
              spaceId: connection.spaceId,
              userId: connection.userId,
              member: { user: { deactivatedAt: null } },
            },
          });
          const status =
            connection.disconnecting || !member || !this.options.enabled(connection.spaceId)
              ? "disconnected"
              : await provider.status(connection.externalCalendarId, lease.signal);
          if (status === "connecting") return;
          if (status === "disconnected") {
            await provider.disconnect(connection.externalCalendarId, lease.signal);
            await prisma.$transaction(async (tx) => {
              await assertLeaseHeld(tx, lease);
              await tx.meetingCalendarConnection.deleteMany({ where: { id: connectionId } });
              for (const booking of connection.bookings)
                await this.closeOrphan(tx, booking.sessionId);
            });
            await this.options.publish(connection);
            return;
          }

          const events = [];
          for await (const event of provider.listEvents(
            connection.externalCalendarId,
            { upcoming: this.now() },
            lease.signal,
          ))
            events.push(event);

          const bookings = new Map(
            connection.bookings.map((booking) => [booking.eventId, booking]),
          );
          for (const event of events) {
            const previous = bookings.get(event.id);
            bookings.delete(event.id);
            const rule = matchCalendarRule(connection.rules, event);
            const link = this.eligibleLink(event);
            const bot = rule?.botId
              ? await prisma.bot.findFirst({
                  where: { id: rule.botId, spaceId: connection.spaceId, archivedAt: null },
                  select: { id: true, name: true },
                })
              : null;
            if (bot && link && event.meetingUrl) {
              lease.signal.throwIfAborted();
              const key = meetingBookingKey(connection.spaceId, bot.id, link.key, event.startsAt);
              const expiresAt = new Date(event.startsAt.getTime() + MEETING_SESSION_DURATION);
              const session = await this.reserve(
                connection,
                bot.id,
                link.platform,
                event.startsAt,
                expiresAt,
                key,
                lease,
              );
              if (!session) {
                if (previous) await this.removeBooking(connectionId, previous, lease);
                continue;
              }
              const configDigest = createHmac("sha256", this.options.oauthStateKey)
                .update(JSON.stringify([link.url, bot.name, event.startsAt.toISOString()]))
                .digest("base64url");
              if (
                previous?.sessionId === session.id &&
                previous.linked &&
                previous.configDigest === configDigest
              )
                continue;

              if (previous && previous.sessionId !== session.id) {
                await this.removeBooking(connectionId, previous, lease);
              }
              await prisma.$transaction(async (tx) => {
                await assertLeaseHeld(tx, lease);
                await tx.meetingCalendarBooking.upsert({
                  where: { connectionId_eventId: { connectionId, eventId: event.id } },
                  create: {
                    connectionId,
                    eventId: event.id,
                    sessionId: session.id,
                    startsAt: event.startsAt,
                    configDigest,
                  },
                  update: {
                    sessionId: session.id,
                    startsAt: event.startsAt,
                    configDigest,
                    linked: false,
                  },
                });
              });

              const request = await this.options.buildJoin({
                sessionId: session.id,
                meetingUrl: link.url,
                platform: link.platform,
                botName: `${bot.name.slice(0, 88)} · Rakazo`,
                expiresAt,
              });
              const externalId = await provider.schedule(
                event.id,
                key,
                event.startsAt,
                request,
                lease.signal,
              );
              await prisma.$transaction(async (tx) => {
                await assertLeaseHeld(tx, lease);
                await tx.meetingCalendarBooking.update({
                  where: { connectionId_eventId: { connectionId, eventId: event.id } },
                  data: { linked: true },
                });
                await tx.meetingSession.updateMany({
                  where: { id: session.id, status: "scheduled" },
                  data: { externalId },
                });
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
              });
            } else if (previous) {
              await this.removeBooking(connectionId, previous, lease);
            }
          }
          for (const booking of bookings.values()) {
            if (booking.startsAt > this.now())
              await this.removeBooking(connectionId, booking, lease);
          }
          await this.options.publish(connection);
        },
      ),
    );
  }

  private async reserve(
    connection: Connection,
    botId: string,
    platform: MeetingJoinRequest["platform"],
    startsAt: Date,
    expiresAt: Date,
    key: string,
    lease: HeldLease,
  ) {
    const { prisma, provider } = this.options;
    return withLease(
      prisma,
      `meeting-admission:${connection.spaceId}`,
      { ttlMs: 15_000, signal: lease.signal },
      (admission) =>
        prisma.$transaction(async (tx) => {
          await assertLeaseHeld(tx, lease);
          await assertLeaseHeld(tx, admission);
          const existing = await tx.meetingSession.findUnique({
            where: { activeKey: key },
            select: { id: true },
          });
          if (existing) return existing;

          const dayStart = new Date(
            Date.UTC(startsAt.getUTCFullYear(), startsAt.getUTCMonth(), startsAt.getUTCDate()),
          );
          const time = { gte: dayStart, lt: new Date(dayStart.getTime() + DAY_MS) };
          const count = await tx.meetingSession.count({
            where: {
              spaceId: connection.spaceId,
              OR: [
                { scheduledFor: time, status: { not: "ended" } },
                { scheduledFor: null, createdAt: time },
              ],
            },
          });
          if (count >= MEETING_DAILY_LIMIT) return null;

          const id = randomUUID();
          await tx.meetingSession.create({
            data: {
              id,
              spaceId: connection.spaceId,
              userId: connection.userId,
              botId,
              provider: provider.id,
              platform,
              status: "scheduled",
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
          return { id };
        }),
    );
  }

  private async removeBooking(connectionId: string, booking: Booking, lease: HeldLease) {
    await this.options.provider.unschedule(booking.eventId, lease.signal);
    await this.options.prisma.$transaction(async (tx) => {
      await assertLeaseHeld(tx, lease);
      await tx.meetingCalendarBooking.deleteMany({
        where: { connectionId, eventId: booking.eventId },
      });
      await this.closeOrphan(tx, booking.sessionId);
    });
  }

  private async closeOrphan(tx: Prisma.TransactionClient, sessionId: string) {
    const remaining = await tx.meetingCalendarBooking.count({ where: { sessionId } });
    if (remaining) return;
    await tx.meetingSession.updateMany({
      where: { id: sessionId, status: "scheduled" },
      data: { status: "ended", activeKey: null, closedAt: this.now() },
    });
  }

  private connection({ spaceId, userId }: Owner): Promise<Connection | null> {
    return this.options.prisma.meetingCalendarConnection.findFirst({
      where: { spaceId, userId, provider: this.options.provider.id },
    });
  }

  private eligibleLink(event: MeetingCalendarEvent) {
    if (
      event.cancelled ||
      event.declined ||
      event.startsAt <= this.now() ||
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

  private verifier(state: string) {
    return createHmac("sha256", this.options.oauthStateKey)
      .update(`meeting-calendar:${state}`)
      .digest("base64url");
  }

  private redirectUri(webOrigin: string) {
    return new URL(MEETING_CALENDAR_CALLBACK_PATH, webOrigin).toString();
  }

  private backup(connectionId: string) {
    return {
      name: "meeting.calendar-sync" as const,
      payload: { connectionId },
      queueName: `meeting-calendar:${connectionId}`,
      replaceKey: `meeting-calendar:${randomUUID()}`,
      availableAt: new Date(this.now().getTime() + SYNC_MS + CLEANUP_MARGIN_MS),
    };
  }

  private async runNow(backup: ReturnType<MeetingCalendarService["backup"]>) {
    try {
      await this.sync(backup.payload.connectionId);
    } catch (error) {
      const delay = error instanceof RetryJobLaterError ? error.delayMs : 0;
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
