import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type {
  JobPublisher,
  MeetingCalendarEvent,
  MeetingCalendarProvider,
  MeetingJoinRequest,
} from "@rakazo/adapter-kit";
import { MeetingCalendarConnectRejected, RetryJobLaterError } from "@rakazo/adapter-kit";
import type { Actor, RpcOutput } from "@rakazo/contracts";
import { MEETING_CALENDAR_CALLBACK_PATH } from "@rakazo/contracts";
import { ClientError, deadlineSignal } from "@rakazo/core";
import type { HeldLease, Prisma, PrismaClient } from "@rakazo/db";
import { assertLeaseHeld, LeaseHeldError, runAsSystem, runAsTenant, withLease } from "@rakazo/db";
import { bestEffort } from "@rakazo/logging";
import {
  countSpaceMeetingsForDay,
  MEETING_DAILY_LIMIT,
  MEETING_SESSION_DURATION,
  parseMeetingUrl,
} from "../meeting-service.js";
import { matchCalendarRule, meetingBookingKey } from "./calendar-rules.js";

const OAUTH_SESSION_MS = 10 * 60_000;
const CONNECT_RECOVERY_MS = 10 * 60_000;
const CONNECT_RETRY_MS = 30_000;
const CONNECT_TIMEOUT_MS = 20_000;
const SYNC_MS = 60_000;
const CLEANUP_MARGIN_MS = 5_000;
const ADMISSION_RECHECK_MS = 2 * 60_000;

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
      connecting: Boolean(
        connection && !connection.externalCalendarId && !connection.disconnecting,
      ),
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
    const backup = this.backup(connectionId, CONNECT_TIMEOUT_MS);
    await withLease(
      prisma,
      `meeting-calendar:${connectionId}`,
      { ttlMs: 30_000, signal: deadlineSignal(CONNECT_TIMEOUT_MS) },
      async (lease) => {
        await prisma.$transaction(async (tx) => {
          await assertLeaseHeld(tx, lease);
          const consumed = await tx.meetingCalendarAuthorization.deleteMany({
            where: { ...scope, id: state, expiresAt: { gt: this.now() } },
          });
          if (!consumed.count) {
            throw new ClientError("BAD_REQUEST", "Start the calendar sign-in again.");
          }
          if (await tx.meetingCalendarConnection.findUnique({ where: { spaceId_userId: scope } })) {
            throw new ClientError("CONFLICT", "A calendar is already connected in this Space.");
          }
          await tx.meetingCalendarConnection.create({
            data: { ...scope, id: connectionId, provider: provider.id, createdAt: this.now() },
          });
          await this.options.jobs.enqueueIn(tx, backup);
        });

        const { calendarId } = await provider
          .connect(
            {
              connectionRef: this.connectionRef(connectionId),
              code,
              verifier: this.verifier(state),
              redirectUri: this.redirectUri(webOrigin),
            },
            lease.signal,
          )
          .catch(async (error: unknown) => {
            if (!(error instanceof MeetingCalendarConnectRejected)) {
              throw new ClientError(
                "SERVICE_UNAVAILABLE",
                "Calendar sign-in could not be confirmed. Check the connection in Rakazo.",
                undefined,
                { cause: error },
              );
            }
            await prisma.$transaction(async (tx) => {
              await assertLeaseHeld(tx, lease);
              await tx.meetingCalendarConnection.deleteMany({
                where: { id: connectionId, externalCalendarId: null },
              });
              await this.options.jobs.cancelIn(tx, backup.replaceKey);
            });
            throw new ClientError("BAD_REQUEST", error.message);
          });

        // A disconnect can mark the row during the exchange. Preserve that intent
        // while recording which provider calendar recovery must remove.
        await prisma.$transaction(async (tx) => {
          await assertLeaseHeld(tx, lease);
          await tx.meetingCalendarConnection.update({
            where: { id: connectionId },
            data: { externalCalendarId: calendarId },
          });
        });
      },
    );
    await bestEffort("reconcile newly connected calendar", this.runNow(backup));
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

  async disconnectUser(userId: string) {
    const { prisma, jobs, provider } = this.options;
    const backups = await runAsSystem("remove calendar access for a deleted account", () =>
      prisma.$transaction(async (tx) => {
        const rows = await tx.meetingCalendarConnection.updateManyAndReturn({
          where: { userId, provider: provider.id },
          data: { disconnecting: true },
          select: { id: true },
        });
        const pending = rows.map(({ id }) => this.backup(id));
        if (pending.length) await jobs.enqueueManyIn(tx, pending);
        return pending;
      }),
    );
    for (const backup of backups) {
      void bestEffort("disconnect deleted account calendar", this.runNow(backup));
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
            await provider.disconnect(calendarId, lease.signal);
            await prisma.$transaction(async (tx) => {
              await assertLeaseHeld(tx, lease);
              await tx.meetingCalendarConnection.deleteMany({ where: { id: connectionId } });
              for (const booking of connection.bookings)
                await this.reconcileBookingOwner(tx, booking.sessionId);
            });
            await this.options.publish(connection);
            return;
          }

          const events = [];
          for await (const event of provider.listEvents(
            calendarId,
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
              const configDigest = createHmac("sha256", this.options.oauthStateKey)
                .update(JSON.stringify([link.url, bot.name, event.startsAt.toISOString()]))
                .digest("base64url");
              if (previous) {
                const reserved = await prisma.meetingSession.findFirst({
                  where: { id: previous.sessionId, activeKey: key },
                  select: { id: true },
                });
                if (reserved && previous.linked && previous.configDigest === configDigest) continue;
                if (!reserved) await this.removeBooking(connectionId, previous, lease);
              }

              const sessionId = await this.reserve(
                connection,
                bot.id,
                link.platform,
                { eventId: event.id, startsAt: event.startsAt, configDigest, expiresAt, key },
                lease,
              );
              if (!sessionId) continue;

              const request = await this.options.buildJoin({
                sessionId,
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
                  where: { id: sessionId, status: "scheduled" },
                  data: { externalId },
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
              });
            } else if (previous) {
              await this.removeBooking(connectionId, previous, lease);
            }
          }
          for (const booking of bookings.values()) {
            if (booking.startsAt > this.now())
              await this.removeBooking(connectionId, booking, lease);
          }
          await this.publishChanges(connection, events, lease);
        },
      ),
    );
  }

  private async recoverConnection(connection: Connection, lease: HeldLease) {
    const { provider, prisma } = this.options;
    const remote = await provider.findConnection(
      this.connectionRef(connection.id),
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
    botId: string,
    platform: MeetingJoinRequest["platform"],
    {
      eventId,
      startsAt,
      configDigest,
      expiresAt,
      key,
    }: {
      eventId: string;
      startsAt: Date;
      expiresAt: Date;
      configDigest: string;
      key: string;
    },
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
          // Reserve the link with the session. Last-unlink cleanup locks the same
          // session row and keeps it while another calendar is being attached.
          const [existing] = await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM meeting_sessions WHERE "activeKey" = ${key} FOR UPDATE
        `;
          if (
            !existing &&
            (await countSpaceMeetingsForDay(tx, connection.spaceId, startsAt)) >=
              MEETING_DAILY_LIMIT
          ) {
            return null;
          }
          const id = existing?.id ?? randomUUID();
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
            create: { connectionId: connection.id, eventId, sessionId: id, startsAt, configDigest },
            update: { sessionId: id, startsAt, configDigest, linked: false },
          });
          return id;
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
      .map(({ connection }) => connection.userId);
    if (bookers.includes(session.userId)) return;
    const members = await tx.spaceMember.findMany({
      where: {
        spaceId: session.spaceId,
        userId: { in: bookers },
        member: { user: { deactivatedAt: null } },
      },
      select: { userId: true },
    });
    const active = new Set(members.map(({ userId }) => userId));
    const owner = bookers.find((userId) => active.has(userId));
    if (owner) {
      await tx.meetingSession.update({ where: { id: sessionId }, data: { userId: owner } });
    }
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

  private connectionRef(id: string) {
    const signature = createHmac("sha256", this.options.oauthStateKey)
      .update(`meeting-calendar-connection:${id}`)
      .digest("base64url");
    return `${id}.${signature}`;
  }

  private matchConnectionRef(ref?: string) {
    const id = ref?.split(".", 1)[0];
    if (!id || !ref || !/^[0-9a-f-]{36}$/u.test(id)) return null;
    const expected = Buffer.from(this.connectionRef(id));
    const received = Buffer.from(ref);
    return expected.length === received.length && timingSafeEqual(expected, received) ? id : null;
  }

  private verifier(state: string) {
    return createHmac("sha256", this.options.oauthStateKey)
      .update(`meeting-calendar:${state}`)
      .digest("base64url");
  }

  private redirectUri(webOrigin: string) {
    return new URL(MEETING_CALENDAR_CALLBACK_PATH, webOrigin).toString();
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

  private async runNow(backup: ReturnType<MeetingCalendarService["backup"]>) {
    try {
      await this.sync(backup.payload.connectionId);
    } catch (error) {
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
