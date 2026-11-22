import { randomUUID } from "node:crypto";
import type { JobPublisher, MeetingJoinRequest } from "@rakazo/adapter-kit";
import { createDb, runAsSystem, runAsTenant } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import type { ScheduledMeetingBots } from "../../providers/meeting/caldav/caldav-calendar-provider.js";
import { CalDavCalendarProvider } from "../../providers/meeting/caldav/caldav-calendar-provider.js";
import { PrismaMeetingCalendarAccounts } from "./calendar-accounts.js";
import { MeetingCalendarService } from "./calendar-service.js";

const postgres =
  process.env.VERIFY_DATABASE === "1" && process.env.DATABASE_URL ? describe : describe.skip;

const origin = "https://caldav.example.test";
const meeting = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "BEGIN:VEVENT",
  "UID:planning",
  "DTSTAMP:20261101T000000Z",
  "DTSTART:20261120T150000Z",
  "DTEND:20261120T160000Z",
  "SUMMARY:Planning",
  "LOCATION:https://example.zoom.us/j/123456789",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

/** One CalDAV account per user, each holding the same shared meeting. */
function caldavServer() {
  const multistatus = (body: string) =>
    new Response(
      `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">${body}</d:multistatus>`,
      { status: 207 },
    );
  const ok = (href: string, props: string) =>
    `<d:response><d:href>${href}</d:href><d:propstat><d:prop>${props}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
  return vi.fn(async (url: URL, init: RequestInit) => {
    const auth = new Headers(init.headers).get("authorization") ?? "";
    const [user, password] = Buffer.from(auth.replace(/^Basic /u, ""), "base64")
      .toString()
      .split(":");
    if (password !== "app-password") return new Response("", { status: 401 });
    const home = `/${user}/calendars/`;
    const body = String(init.body ?? "");
    if (init.method === "PROPFIND" && body.includes("current-user-principal"))
      return multistatus(
        ok("/", `<d:current-user-principal><d:href>/${user}/</d:href></d:current-user-principal>`),
      );
    if (init.method === "PROPFIND" && body.includes("calendar-home-set"))
      return multistatus(
        ok(`/${user}/`, `<c:calendar-home-set><d:href>${home}</d:href></c:calendar-home-set>`),
      );
    if (init.method === "PROPFIND")
      return multistatus(
        ok(`${home}work/`, "<d:resourcetype><d:collection/><c:calendar/></d:resourcetype>"),
      );
    if (init.method === "REPORT")
      return multistatus(
        ok(`${home}work/planning.ics`, `<c:calendar-data>${meeting}</c:calendar-data>`),
      );
    if (init.method === "GET" && url.pathname === `${home}work/planning.ics`)
      return new Response(meeting);
    return new Response("", { status: 404 });
  });
}

postgres("CalDAV meeting calendars (PostgreSQL)", () => {
  it("shares one reserved participant between members and releases it with the last booking", async () => {
    const { prisma, pool } = createDb(process.env.DATABASE_URL!);
    const org = randomUUID();
    const spaceId = randomUUID();
    const botId = randomUUID();
    const first = { spaceId, userId: randomUUID() };
    const second = { spaceId, userId: randomUUID() };
    const now = new Date("2026-11-18T10:00:00Z");
    const resolved = async () => {};
    const jobs: JobPublisher = {
      enqueue: vi.fn(resolved),
      enqueueIn: vi.fn(resolved),
      enqueueManyIn: vi.fn(resolved),
      cancel: vi.fn(resolved),
      cancelIn: vi.fn(resolved),
      close: vi.fn(resolved),
    };
    const reserved = new Map<string, string>();
    const bots: ScheduledMeetingBots = {
      schedule: vi.fn(async (request: MeetingJoinRequest) => {
        const id = reserved.get(request.sessionId) ?? randomUUID();
        reserved.set(request.sessionId, id);
        return id;
      }),
      cancel: vi.fn(async (sessionId: string) => {
        reserved.delete(sessionId);
      }),
    };
    const accounts = new PrismaMeetingCalendarAccounts(prisma, "test-encryption-key-for-calendars");
    const provider = new CalDavCalendarProvider({
      accounts,
      bots,
      fetch: caldavServer(),
      now: () => now,
    });
    const service = new MeetingCalendarService({
      prisma,
      provider,
      jobs,
      accounts,
      webOrigin: "https://rakazo.example.test",
      oauthStateKey: "offline-fixture-key",
      enabled: (space) => space === spaceId,
      buildJoin: (input) => input,
      publish: vi.fn(resolved),
      now: () => now,
    });
    try {
      await runAsSystem("seed CalDAV calendar fixture", async () => {
        await prisma.organization.create({
          data: { id: org, name: "CalDAV test", slug: org, createdAt: now },
        });
        await prisma.space.create({
          data: { id: spaceId, name: "CalDAV test", organizationId: org },
        });
        for (const { userId } of [first, second]) {
          await prisma.user.create({
            data: { id: userId, name: "CalDAV fixture", email: `${userId}@rakazo.test` },
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

      const connect = (owner: typeof first, password = "app-password") =>
        runAsTenant(owner, () =>
          service.authorization.connectAccount(owner, {
            serverUrl: origin,
            username: owner.userId,
            password,
          }),
        );
      await expect(connect(first, "wrong")).rejects.toMatchObject({ kind: "BAD_REQUEST" });
      await expect(
        runAsTenant(first, () => service.authorization.begin(first, "web", { botId })),
      ).rejects.toMatchObject({ kind: "BAD_REQUEST" });
      await connect(first);
      await connect(second);
      await expect(connect(first)).rejects.toMatchObject({ kind: "CONFLICT" });

      const stored = await runAsSystem("read sealed calendar account", () =>
        prisma.meetingCalendarConnection.findFirstOrThrow({ where: first }),
      );
      expect(stored.accountCiphertext).toBeTruthy();
      expect(stored.accountCiphertext).not.toContain("app-password");

      const listing = (owner: typeof first) =>
        runAsTenant(owner, () => service.upcoming(owner, botId));
      const firstView = await listing(first);
      expect(firstView).toMatchObject({ connected: true, signIn: "password" });
      const [firstEvent] = firstView.events;
      const [secondEvent] = (await listing(second)).events;
      expect(firstEvent).toMatchObject({ title: "Planning", platform: "zoom", recurring: false });
      await expect(
        runAsTenant(second, () => service.updateSelection(second, botId, firstEvent!.id, "once")),
      ).rejects.toMatchObject({ kind: "NOT_FOUND" });

      await runAsTenant(first, () => service.updateSelection(first, botId, firstEvent!.id, "once"));
      await runAsTenant(second, () =>
        service.updateSelection(second, botId, secondEvent!.id, "once"),
      );
      expect(reserved.size).toBe(1);
      const [sessionId, externalId] = [...reserved][0]!;
      expect(bots.schedule).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId, meetingUrl: "https://example.zoom.us/j/123456789" }),
        new Date("2026-11-20T15:00:00Z"),
        expect.anything(),
      );
      expect((await listing(first)).events[0]).toMatchObject({ scheduled: true });

      // The other member still needs the participant.
      await runAsTenant(first, () => service.updateSelection(first, botId, firstEvent!.id, "skip"));
      expect(bots.cancel).not.toHaveBeenCalled();
      expect(reserved.get(sessionId!)).toBe(externalId);

      await runAsTenant(second, () =>
        service.updateSelection(second, botId, secondEvent!.id, "skip"),
      );
      expect(bots.cancel).toHaveBeenCalledWith(sessionId, externalId, expect.anything());
      expect(reserved.size).toBe(0);

      // Disconnecting releases the participants the calendar booked.
      await runAsTenant(first, () => service.updateSelection(first, botId, firstEvent!.id, "once"));
      expect(reserved.size).toBe(1);
      await runAsTenant(first, () => service.disconnect(first));
      expect(reserved.size).toBe(0);
      expect(
        await runAsSystem("check removed calendar", () =>
          prisma.meetingCalendarConnection.findFirst({ where: first }),
        ),
      ).toBeNull();
    } finally {
      await runAsSystem("remove CalDAV calendar fixture", async () => {
        await prisma.meetingSession.deleteMany({ where: { spaceId } });
        await prisma.meetingCalendarConnection.deleteMany({ where: { spaceId } });
        await prisma.organization.deleteMany({ where: { id: org } });
        await prisma.user.deleteMany({ where: { id: { in: [first.userId, second.userId] } } });
      });
      await prisma.$disconnect();
      await pool.end();
    }
  });
});
