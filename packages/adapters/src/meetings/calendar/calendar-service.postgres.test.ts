import { randomUUID } from "node:crypto";
import type { JobPublisher, MeetingJoinRequest } from "@rakazo/adapter-kit";
import { deferred } from "@rakazo/core/test-async";
import { createDb, leaveSpace, runAsSystem, runAsTenant } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { RecallCalendarEmulator } from "../../providers/meeting/recall/calendar-emulator.js";
import { countSpaceMeetingsForDay, countSpaceMeetingsInPastDay } from "../meeting-service.js";
import { MeetingCalendarService } from "./calendar-service.js";

const postgres =
  process.env.VERIFY_DATABASE === "1" && process.env.DATABASE_URL ? describe : describe.skip;

postgres("meeting calendar reconciliation (PostgreSQL)", () => {
  it("reconciles series, occurrence overrides, edits, deduplication, and disconnects", async () => {
    const { prisma, pool } = createDb(process.env.DATABASE_URL!);
    const org = randomUUID();
    const spaceId = randomUUID();
    const botId = randomUUID();
    const first = { spaceId, userId: randomUUID() };
    const second = { spaceId, userId: randomUUID() };
    const now = new Date("2026-11-18T10:00:00Z");
    let clock = now;
    const emulator = new RecallCalendarEmulator(now);
    const resolved = async () => {};
    const jobs: JobPublisher = {
      enqueue: vi.fn(resolved),
      enqueueIn: vi.fn(resolved),
      enqueueManyIn: vi.fn(resolved),
      cancel: vi.fn(resolved),
      cancelIn: vi.fn(resolved),
      close: vi.fn(resolved),
    };
    const publish = vi.fn(resolved);
    const buildJoin = vi.fn((input: MeetingJoinRequest) => Promise.resolve(input));
    const service = new MeetingCalendarService({
      prisma,
      provider: emulator.provider,
      jobs,
      webOrigin: "https://rakazo.example.test",
      oauthStateKey: "offline-fixture-key",
      enabled: (space) => space === spaceId,
      buildJoin,
      publish,
      now: () => clock,
    });
    try {
      await runAsSystem("seed calendar integration fixture", async () => {
        await prisma.organization.create({
          data: { id: org, name: "Calendar test", slug: org, createdAt: now },
        });
        await prisma.space.create({
          data: { id: spaceId, name: "Calendar test", organizationId: org },
        });
        for (const { userId } of [first, second]) {
          await prisma.user.create({
            data: { id: userId, name: "Calendar fixture", email: `${userId}@rakazo.test` },
          });
          await prisma.member.create({
            data: { id: randomUUID(), organizationId: org, userId, role: "member", createdAt: now },
          });
          await prisma.spaceMember.create({
            data: {
              id: randomUUID(),
              organizationId: org,
              spaceId,
              userId,
              role: "member",
              createdAt: now,
            },
          });
        }
        await prisma.bot.create({
          data: { id: botId, spaceId, userId: first.userId, name: "Atlas", color: "ink" },
        });
      });

      const start = await runAsTenant(first, () =>
        service.authorization.begin(first, "web", { botId }),
      );
      const firstCode = new URL(start.authorizationUrl).searchParams.get("code")!;
      await expect(
        service.authorization.completeFromBrowser(second.userId, start.state, firstCode),
      ).rejects.toMatchObject({
        kind: "BAD_REQUEST",
      });
      await expect(
        service.authorization.completeFromBrowser(first.userId, start.state, firstCode),
      ).resolves.toBe(botId);
      const startSecond = await runAsTenant(second, () =>
        service.authorization.begin(second, "web"),
      );
      await service.authorization.completeFromBrowser(
        second.userId,
        startSecond.state,
        new URL(startSecond.authorizationUrl).searchParams.get("code")!,
      );

      const listing = (owner: typeof first) =>
        runAsTenant(owner, () => service.upcoming(owner, botId));
      const firstEvents = (await listing(first)).events;
      const secondEvents = (await listing(second)).events;
      const firstReview = firstEvents[0]!;
      const secondReview = secondEvents[0]!;
      const lastReview = firstEvents.at(-1)!;

      await expect(
        runAsTenant(second, () => service.updateSelection(second, botId, firstReview.id, "once")),
      ).rejects.toMatchObject({ kind: "NOT_FOUND" });
      const teamsLink =
        "https://teams.microsoft.com/l/meetup-join/19%3Ameeting_Fake%2Bthread%40thread.v2/0?context=%7B%22Tid%22%3A%22fake-tenant%22%7D";
      emulator.revision(lastReview.id, { meeting_url: teamsLink });
      expect((await listing(first)).events.find(({ id }) => id === lastReview.id)).toMatchObject({
        platform: "microsoft_teams",
      });
      await runAsTenant(first, () => service.updateSelection(first, botId, lastReview.id, "once"));
      expect(emulator.scheduledLink(lastReview.id)).toBe(teamsLink);
      await runAsTenant(first, () =>
        service.updateSelection(first, botId, firstReview.id, "series"),
      );
      expect(emulator.scheduled(firstReview.id)).toBeTruthy();
      expect(emulator.scheduled(lastReview.id)).toBeTruthy();
      await runAsTenant(first, () =>
        service.updateSelection(first, botId, firstReview.id, "removeSeries"),
      );
      expect(emulator.scheduled(firstReview.id)).toBeUndefined();
      expect(emulator.scheduled(lastReview.id)).toBeUndefined();
      await runAsTenant(first, () =>
        service.updateSelection(first, botId, firstReview.id, "series"),
      );
      await runAsTenant(second, () =>
        service.updateSelection(second, botId, secondReview.id, "once"),
      );
      const firstConnection = await runAsTenant(first, () =>
        prisma.meetingCalendarConnection.findFirstOrThrow({ where: first }),
      );
      publish.mockClear();
      await service.sync(firstConnection.id);
      expect(publish).not.toHaveBeenCalled();
      expect(emulator.scheduled(firstReview.id)).toBeTruthy();
      expect(emulator.scheduled(firstReview.id)).toBe(emulator.scheduled(secondReview.id));
      expect(emulator.scheduled(lastReview.id)).toBeTruthy();
      const reservation = emulator.scheduled(firstReview.id);
      const ownReservation = () =>
        runAsTenant(first, () =>
          prisma.meetingSession.findFirstOrThrow({
            where: { provider: emulator.provider.id, externalId: reservation },
          }),
        );
      expect((await ownReservation()).shareTranscript).toBe(false);
      await runAsTenant(second, () =>
        service.updateSelection(second, botId, secondReview.id, "once", true),
      );
      expect((await ownReservation()).shareTranscript).toBe(false);
      const scheduleOnSharingChange = vi.spyOn(emulator.provider, "schedule");
      await runAsTenant(first, () =>
        service.updateSelection(first, botId, firstReview.id, "series", true),
      );
      expect((await ownReservation()).shareTranscript).toBe(true);
      expect(emulator.scheduled(firstReview.id)).toBe(reservation);
      expect(scheduleOnSharingChange).not.toHaveBeenCalled();
      scheduleOnSharingChange.mockRestore();
      expect(jobs.enqueueIn).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          name: "meeting.work",
          payload: expect.objectContaining({ action: "expire" }),
        }),
      );

      await runAsTenant(first, () => service.updateSelection(first, botId, firstReview.id, "skip"));
      expect(emulator.scheduled(firstReview.id)).toBeUndefined();
      expect(emulator.scheduled(secondReview.id)).toBeTruthy();

      const shared = await runAsTenant(second, () =>
        prisma.meetingSession.findFirst({
          where: {
            provider: emulator.provider.id,
            externalId: emulator.scheduled(secondReview.id),
          },
        }),
      );
      expect(shared?.userId).toBe(second.userId);
      expect(shared?.shareTranscript).toBe(true);
      expect(
        await runAsTenant(first, () =>
          prisma.meetingSession.findFirst({
            where: { id: shared?.id },
          }),
        ),
      ).toBeNull();

      const old = emulator.scheduled(lastReview.id);
      emulator.revision(lastReview.id, {
        start_time: new Date(lastReview.startsAt + 60_000).toISOString(),
        end_time: new Date(lastReview.endsAt + 60_000).toISOString(),
      });
      const owner = await runAsTenant(first, () =>
        prisma.meetingCalendarConnection.findFirstOrThrow({ where: first }),
      );
      await service.sync(owner.id);
      expect(emulator.scheduled(lastReview.id)).toBeTruthy();
      expect(emulator.scheduled(lastReview.id)).not.toBe(old);
      const laterDate = now.getTime() + 15 * 24 * 60 * 60_000;
      emulator.revision(lastReview.id, {
        start_time: new Date(laterDate).toISOString(),
        end_time: new Date(laterDate + 30 * 60_000).toISOString(),
      });
      await service.sync(owner.id);
      expect(emulator.scheduled(lastReview.id)).toBeUndefined();
      expect((await listing(first)).events.some(({ id }) => id === lastReview.id)).toBe(false);
      clock = new Date(now.getTime() + 2 * 24 * 60 * 60_000);
      await service.sync(owner.id);
      expect(emulator.scheduled(lastReview.id)).toBeTruthy();
      clock = now;
      emulator.revision(lastReview.id, { is_deleted: true });
      await service.sync(owner.id);
      expect(emulator.scheduled(lastReview.id)).toBeUndefined();

      const zoom = firstEvents.find(({ platform }) => platform === "zoom")!;
      const fullDay = new Date(zoom.startsAt);
      const quotaSessions = Array.from({ length: 20 }, () => randomUUID());
      await runAsSystem("seed completed meetings on the calendar event's UTC day", () =>
        prisma.meetingSession.createMany({
          data: quotaSessions.map((id) => ({
            id,
            spaceId,
            userId: second.userId,
            botId,
            platform: "zoom",
            provider: emulator.provider.id,
            status: "ended",
            createdAt: fullDay,
            expiresAt: fullDay,
          })),
        }),
      );

      const afterMidnight = new Date(
        Date.UTC(fullDay.getUTCFullYear(), fullDay.getUTCMonth(), fullDay.getUTCDate() + 1, 0, 1),
      );
      await runAsSystem("compare the UTC day and rolling meeting usage", async () => {
        expect(await countSpaceMeetingsForDay(prisma, spaceId, afterMidnight)).toBe(0);
        expect(await countSpaceMeetingsInPastDay(prisma, spaceId, afterMidnight)).toBe(20);
      });

      await runAsTenant(first, () => service.updateSelection(first, botId, zoom.id, "once"));
      expect(emulator.scheduled(zoom.id)).toBeUndefined();
      expect((await listing(first)).events.find(({ id }) => id === zoom.id)).toMatchObject({
        selection: "once",
        scheduled: false,
        quotaReached: true,
      });
      await runAsSystem("free calendar capacity", () =>
        prisma.meetingSession.deleteMany({ where: { id: { in: quotaSessions } } }),
      );
      await service.sync(owner.id);
      const originalBot = emulator.scheduled(zoom.id);
      expect(originalBot).toBeTruthy();
      expect((await listing(first)).events.find(({ id }) => id === zoom.id)).toMatchObject({
        scheduled: true,
        quotaReached: false,
      });
      const revisedLink = "https://zoom.us/j/12345678901?pwd=changed-fixture-password";
      emulator.revision(zoom.id, { meeting_url: revisedLink });
      await service.sync(owner.id);
      expect(emulator.scheduled(zoom.id)).toBe(originalBot);
      expect(emulator.scheduledLink(zoom.id)).toBe(revisedLink);
      emulator.revision(zoom.id, {
        meeting_url: "https://zoom.us/j/12345678901?pwd=retry-fixture",
      });
      emulator.denyNextSchedule(503);
      await expect(service.sync(owner.id)).rejects.toThrow();
      expect(emulator.scheduled(zoom.id)).toBe(originalBot);
      emulator.denyNextSchedule(400);
      await service.sync(owner.id);
      expect(emulator.scheduled(zoom.id)).toBeUndefined();
      expect((await listing(first)).events.find(({ id }) => id === zoom.id)?.selection).toBe(
        "skipped",
      );
      await runAsTenant(first, () => service.updateSelection(first, botId, zoom.id, "once"));
      expect(emulator.scheduled(zoom.id)).toBeTruthy();

      await runAsSystem("deactivate the calendar owner", () =>
        prisma.user.update({ where: { id: first.userId }, data: { deactivatedAt: now } }),
      );
      await service.sync(owner.id);
      expect(emulator.scheduled(zoom.id)).toBeUndefined();
      expect((await listing(first)).connected).toBe(false);
      await runAsTenant(second, () => service.disconnect(second));
      expect(emulator.scheduled(secondReview.id)).toBeUndefined();
      expect((await listing(second)).connected).toBe(false);
      const authorize = async () => {
        const began = await runAsTenant(second, () => service.authorization.begin(second, "web"));
        const code = new URL(began.authorizationUrl).searchParams.get("code")!;
        return {
          complete: () =>
            service.authorization.completeFromBrowser(second.userId, began.state, code),
        };
      };
      const unavailable = await authorize();
      emulator.failNextOAuthExchange(503);
      await expect(unavailable.complete()).rejects.toMatchObject({ kind: "SERVICE_UNAVAILABLE" });
      expect((await listing(second)).connecting).toBe(false);

      const sessionId = randomUUID();
      await runAsSystem("register desktop test session", () =>
        prisma.session.create({
          data: {
            id: sessionId,
            userId: second.userId,
            token: randomUUID(),
            expiresAt: new Date(clock.getTime() + 60 * 60_000),
          },
        }),
      );
      const desktop = await runAsTenant(second, () =>
        service.authorization.begin(second, "desktop", {
          loopbackPort: 52_133,
          sessionId,
        }),
      );
      const launch = new URL(desktop.authorizationUrl);
      const loopback = await service.authorization.desktopHandoff(desktop.state);
      expect(loopback?.href).toBe("http://127.0.0.1:52133/meeting-calendar/callback");
      expect(launch.searchParams.get("redirect_uri")).toBe(loopback?.href);
      const providerUrl = await service.authorization.launchDesktop(desktop.state);
      expect(providerUrl).toBeTruthy();
      const desktopCode = new URL(providerUrl!).searchParams.get("code")!;
      await expect(
        runAsTenant(second, () =>
          service.authorization.complete(second, desktop.state, desktopCode, "other-session"),
        ),
      ).rejects.toMatchObject({ kind: "BAD_REQUEST" });
      await runAsTenant(second, () =>
        service.authorization.complete(second, desktop.state, desktopCode, sessionId),
      );
      expect(await service.authorization.desktopHandoff(desktop.state)).toBeNull();

      const connected = await runAsTenant(second, () =>
        prisma.meetingCalendarConnection.findFirstOrThrow({ where: second }),
      );
      expect(jobs.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "meeting.calendar-sync",
          replaceKey: expect.stringContaining(`meeting-calendar:refresh:${connected.id}:`),
        }),
      );
      const events = (await listing(second)).events;
      const review = events[0]!;
      const lateReview = events.at(-1)!;
      emulator.denyNextSchedule(400);
      await runAsTenant(second, () => service.updateSelection(second, botId, review.id, "series"));
      expect(emulator.scheduled(review.id)).toBeUndefined();
      expect(emulator.scheduled(lateReview.id)).toBeTruthy();
      expect((await listing(second)).events.find(({ id }) => id === review.id)?.selection).toBe(
        "skipped",
      );

      const race = events.find(({ platform }) => platform === "zoom")!;
      const preparing = deferred();
      const prepared = deferred();
      buildJoin.mockImplementationOnce(async (input) => {
        preparing.resolve();
        await prepared.promise;
        return input;
      });
      const schedule = vi.spyOn(emulator.provider, "schedule");
      const preparingSchedule = runAsTenant(second, () =>
        service.updateSelection(second, botId, race.id, "once"),
      );
      try {
        await preparing.promise;
        await runAsTenant(second, () => service.updateSelection(second, botId, race.id, "skip"));
      } finally {
        prepared.resolve();
        await preparingSchedule;
      }
      expect(schedule).not.toHaveBeenCalled();
      schedule.mockRestore();

      const skippedDelivery = deferred<void>();
      emulator.holdNextScheduleReply(skippedDelivery.promise);
      const skippedScheduling = runAsTenant(second, () =>
        service.updateSelection(second, botId, race.id, "once"),
      );
      try {
        await vi.waitFor(() => expect(emulator.scheduled(race.id)).toBeTruthy());
        await runAsTenant(second, () => service.updateSelection(second, botId, race.id, "skip"));
      } finally {
        skippedDelivery.resolve();
        await skippedScheduling;
      }
      expect(emulator.scheduled(race.id)).toBeUndefined();
      expect((await listing(second)).events.find(({ id }) => id === race.id)).toMatchObject({
        selection: "skipped",
        scheduled: false,
      });

      const delivery = deferred<void>();
      emulator.holdNextScheduleReply(delivery.promise);
      const scheduling = runAsTenant(second, () =>
        service.updateSelection(second, botId, race.id, "once"),
      );
      let accepted: string | undefined;
      let leaving: string | undefined;
      try {
        await vi.waitFor(() => expect(emulator.scheduled(race.id)).toBeTruthy());
        accepted = emulator.scheduled(race.id);
        await Promise.all(
          Array.from({ length: 3 }, () => service.providerChanged(connected.externalCalendarId!)),
        );
        await vi.waitFor(() => {
          const catchups = vi
            .mocked(jobs.enqueue)
            .mock.calls.map(([job]) => job.replaceKey)
            .filter((key) => key?.startsWith("meeting-calendar:webhook-recheck:"));
          expect(catchups).toEqual(
            Array(3).fill(`meeting-calendar:webhook-recheck:${connected.id}`),
          );
        });
        const booking = await runAsTenant(second, () =>
          prisma.meetingCalendarBooking.findFirstOrThrow({
            where: { eventId: race.id },
          }),
        );
        leaving = booking.sessionId;
        await runAsTenant(second, () =>
          prisma.meetingSession.update({
            where: { id: booking.sessionId },
            data: { status: "leaving" },
          }),
        );
      } finally {
        delivery.resolve();
        await scheduling;
      }
      expect(emulator.scheduled(race.id)).toBeUndefined();
      const leavingSession = await runAsTenant(second, () =>
        prisma.meetingSession.findFirst({ where: { id: leaving } }),
      );
      expect(leavingSession?.externalId).toBe(accepted);
      expect((await listing(second)).events.find(({ id }) => id === race.id)?.selection).toBe(
        "skipped",
      );
      const pastBooking = await runAsTenant(second, () =>
        prisma.meetingCalendarBooking.findFirstOrThrow({ where: { eventId: lateReview.id } }),
      );
      const dayMs = 24 * 60 * 60_000;
      const movedReview = new Date(now.getTime() + 12 * dayMs);
      emulator.revision(review.id, {
        start_time: movedReview.toISOString(),
        end_time: new Date(movedReview.getTime() + 30 * 60_000).toISOString(),
      });
      clock = new Date(lateReview.startsAt - 1);
      const listEvents = emulator.provider.listEvents.bind(emulator.provider);
      const slowList = vi
        .spyOn(emulator.provider, "listEvents")
        .mockImplementationOnce(async function* (...args) {
          yield* listEvents(...args);
          clock = new Date(lateReview.startsAt + 1);
        });
      await service.sync(connected.id);
      slowList.mockRestore();
      const findBooking = () =>
        runAsTenant(second, () =>
          prisma.meetingCalendarBooking.findFirst({
            where: { eventId: lateReview.id },
          }),
        );
      expect(await findBooking()).not.toBeNull();
      expect(emulator.scheduled(lateReview.id)).toBeTruthy();
      await runAsTenant(second, () =>
        prisma.meetingSession.update({
          where: { id: pastBooking.sessionId },
          data: { status: "ended", closedAt: clock },
        }),
      );
      await service.sync(connected.id);
      expect(await findBooking()).toBeNull();
      clock = new Date(now.getTime() + 10 * dayMs);
      await service.sync(connected.id);
      await runAsTenant(second, async () => {
        const rules = await prisma.meetingCalendarRule.findMany({
          where: { connectionId: connected.id },
        });
        expect(rules.some(({ targetId }) => targetId === race.id)).toBe(false);
        expect(rules).toContainEqual(
          expect.objectContaining({ targetId: review.id, eventStartsAt: movedReview, botId: null }),
        );
        expect(rules.some(({ scope }) => scope === "series")).toBe(true);
      });
      expect(emulator.scheduled(review.id)).toBeUndefined();
      clock = now;

      emulator.failNextDisconnect(503);
      await expect(service.disconnectSpace(second.spaceId)).rejects.toThrow();
      expect(emulator.connectedCalendars()).toEqual([connected.externalCalendarId]);
      expect(
        await runAsTenant(second, () =>
          prisma.meetingCalendarConnection.findFirstOrThrow({ where: second }),
        ),
      ).toMatchObject({ disconnecting: true });
      await service.sync(connected.id);
      expect(emulator.connectedCalendars()).toEqual([]);

      const retry = await authorize();
      emulator.loseNextConnectionReply();
      await expect(retry.complete()).rejects.toMatchObject({ kind: "SERVICE_UNAVAILABLE" });
      expect((await listing(second)).connecting).toBe(true);
      const pending = await runAsTenant(second, () =>
        prisma.meetingCalendarConnection.findFirstOrThrow({ where: second }),
      );
      const [acceptedId] = emulator.connectedCalendars();
      expect(jobs.enqueueIn).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          name: "meeting.calendar-sync",
          payload: { connectionId: pending.id },
        }),
      );
      emulator.setCalendarStatus(acceptedId!, "connecting");
      await expect(service.sync(pending.id)).rejects.toMatchObject({ delayMs: 30_000 });
      emulator.setCalendarStatus(acceptedId!, "connected");
      await service.sync(pending.id);
      expect((await listing(second)).connected).toBe(true);
      emulator.failNextDisconnect(503);
      await runAsTenant(second, () => service.disconnect(second));
      expect(await listing(second)).toMatchObject({
        connected: false,
        connecting: false,
        disconnecting: true,
        events: [],
      });
      await expect(authorize()).rejects.toMatchObject({ kind: "CONFLICT" });
      await runAsTenant(second, () => service.disconnect(second));
      expect(emulator.connectedCalendars()).toEqual([]);
      expect((await listing(second)).disconnecting).toBe(false);

      const held = deferred<void>();
      const pendingDisconnect = await authorize();
      emulator.holdNextConnectionReply(held.promise);
      const completing = pendingDisconnect.complete();
      try {
        await vi.waitFor(() => expect(emulator.connectedCalendars()).toHaveLength(1));
        await runAsTenant(second, () => service.disconnect(second));
      } finally {
        held.resolve();
        await completing;
      }
      expect(emulator.connectedCalendars()).toEqual([]);
      expect((await listing(second)).connected).toBe(false);

      const stale = randomUUID();
      await runAsTenant(second, () =>
        prisma.meetingCalendarConnection.create({
          data: { ...second, id: stale, provider: emulator.provider.id, createdAt: clock },
        }),
      );
      clock = new Date(clock.getTime() + 11 * 60_000);
      await service.sync(stale);
      const restart = await authorize();
      emulator.loseNextConnectionReply();
      await expect(restart.complete()).rejects.toMatchObject({ kind: "SERVICE_UNAVAILABLE" });
      const [late] = emulator.connectedCalendars();
      // Simulate an acceptance after recovery pruned the local reservation.
      await runAsTenant(second, () =>
        prisma.meetingCalendarConnection.deleteMany({ where: second }),
      );
      const change = emulator.change(late!);
      expect(service.verifyChange(change.body, change.headers)).toMatchObject({
        kind: "events",
        calendarId: late,
      });
      await service.providerChanged(late!);
      expect(emulator.connectedCalendars()).toEqual([]);

      clock = now;
      const departing = await authorize();
      await departing.complete();
      const departureConnection = await runAsTenant(second, () =>
        prisma.meetingCalendarConnection.findFirstOrThrow({ where: second }),
      );
      const departureEvent = (await listing(second)).events[0]!;
      await runAsTenant(second, () =>
        service.updateSelection(second, botId, departureEvent.id, "once"),
      );
      expect(emulator.scheduled(departureEvent.id)).toBeTruthy();
      await runAsSystem("seed an owner for the departure fixture", () =>
        prisma.spaceMember.update({ where: { spaceId_userId: first }, data: { role: "owner" } }),
      );
      // Commit the departure without running its normal immediate provider cleanup.
      await runAsTenant(second, () => leaveSpace(prisma, second));
      await expect(
        runAsSystem("inspect the departed calendar", () =>
          prisma.meetingCalendarConnection.findUnique({ where: { id: departureConnection.id } }),
        ),
      ).resolves.toMatchObject({ disconnecting: true });
      const backup = await pool.query<{ task_identifier: string }>(
        "SELECT task_identifier FROM graphile_worker.jobs WHERE key = $1",
        [`meeting-calendar:disconnect:${departureConnection.id}`],
      );
      expect(backup.rows).toEqual([{ task_identifier: "meeting.calendar-sync" }]);
      await service.sync(departureConnection.id);
      expect(emulator.connectedCalendars()).toEqual([]);
      expect(emulator.scheduled(departureEvent.id)).toBeUndefined();
    } finally {
      await runAsSystem("clean calendar integration fixture", async () => {
        await prisma.meetingCalendarConnection.deleteMany({ where: { spaceId } });
        await prisma.organization.deleteMany({ where: { id: org } });
        await prisma.user.deleteMany({ where: { id: { in: [first.userId, second.userId] } } });
      });
      await pool.end();
    }
  });
});
