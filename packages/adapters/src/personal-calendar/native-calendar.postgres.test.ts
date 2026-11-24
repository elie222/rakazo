import { randomUUID } from "node:crypto";
import type { CalendarOperation } from "@rakazo/contracts";
import { NATIVE_CALENDAR_WINDOW_MS } from "@rakazo/contracts";
import {
  asSystem,
  contentEncryptionStatus,
  createDb,
  createThreadEvents,
  createThreadMessage,
  LocalKeyProvider,
  provisionMessagingIdentity,
  runAsTenant,
} from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { InMemoryRealtimeFanout } from "../notifications/realtime.js";
import {
  claimNativeCalendar,
  finishNativeCalendar,
  nativeCalendarDeviceDigest,
  pendingNativeCalendar,
  pruneExpiredNativeCalendarRequests,
  requestNativeCalendar,
} from "./native-calendar.js";

const url = process.env.VERIFY_DATABASE === "1" && process.env.DATABASE_URL;

describe.skipIf(!url)("phone calendar execution", () => {
  const lease = { owner: "test-worker", fence: 1 };
  const calendar = { source: "device", accountId: "account", calendarId: "calendar" } as const;
  const operation: CalendarOperation = {
    action: "create_calendar_event",
    input: {
      calendar,
      event: {
        title: "Example event",
        timing: {
          allDay: false,
          start: "2026-12-29T14:00:00+01:00",
          end: "2026-12-29T15:00:00+01:00",
          timeZone: "Europe/Paris",
        },
      },
    },
  };

  let db: ReturnType<typeof createDb>;
  let system: ReturnType<typeof asSystem<typeof db.prisma>>;
  let events: ReturnType<typeof createThreadEvents>;
  let identity: { userId: string; spaceId: string; botId: string; threadId: string };
  let sessionId: string;
  const deviceDigest = nativeCalendarDeviceDigest("test device");

  beforeAll(async () => {
    db = createDb(url as string, {
      keyProvider: new LocalKeyProvider([{ id: "test-key", key: Buffer.alloc(32, 1) }]),
      encryptContent: true,
    });
    system = asSystem(db.prisma);
    events = createThreadEvents(db.prisma, new InMemoryRealtimeFanout());
    const { userId, spaceId, botId, threadId } = await provisionMessagingIdentity(system, {
      provider: "email",
      address: `calendar-${randomUUID()}@example.test`,
    });
    identity = { userId, spaceId, botId, threadId };
    sessionId = randomUUID();
    await system.session.create({
      data: {
        id: sessionId,
        userId,
        token: randomUUID(),
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
  });

  afterAll(async () => {
    if (identity) await system.user.delete({ where: { id: identity.userId } });
    if (db) await db.pool.end();
  });

  async function run(trigger = "user", nativeCalendarSessionId: string | null = sessionId) {
    const source = await createThreadMessage(system, {
      threadId: identity.threadId,
      role: "user",
      authorUserId: identity.userId,
      blocks: [{ kind: "text", text: "Calendar fixture" }],
      nativeCalendarSessionId: nativeCalendarSessionId ?? undefined,
      nativeCalendarDeviceDigest: nativeCalendarSessionId ? deviceDigest : undefined,
    });
    const task = await system.task.create({
      data: { ...identity, prompt: "Calendar fixture", status: "running" },
    });
    return system.run.create({
      data: {
        ...identity,
        sourceMessageId: source.id,
        taskId: task.id,
        trigger,
        status: "running",
        leaseOwner: lease.owner,
        leaseFence: lease.fence,
        leaseExpiresAt: new Date(Date.now() + 10 * 60_000),
      },
    });
  }

  it("delivers to the originating session and claims once, with encrypted content and a replayable result", async () => {
    const record = await run();
    const { userId, spaceId, botId, threadId } = identity;
    const origin = { userId, spaceId, sessionId, deviceDigest };
    const otherPhone = { ...origin, sessionId: "different-session" };
    const inTenant = <T>(work: () => Promise<T>) => runAsTenant(origin, work);
    const deps = { prisma: db.prisma, events };
    const signal = new AbortController();
    const result = inTenant(() =>
      requestNativeCalendar(deps, record, lease, operation, signal.signal),
    );
    const settled = Promise.allSettled([result]);
    try {
      const [pending] = await vi.waitFor(
        async () => {
          const rows = await inTenant(() => pendingNativeCalendar(db.prisma, origin, botId));
          expect(rows).toHaveLength(1);
          return rows;
        },
        { timeout: 8_000 },
      );
      const target = { id: pending!.id, runId: record.id, threadId };
      expect(pending!.remainingMs).toBeGreaterThan(0);
      expect(pending!.remainingMs).toBeLessThanOrEqual(NATIVE_CALENDAR_WINDOW_MS);
      const [raw] = await inTenant(
        () =>
          db.prisma.$queryRaw<Array<{ operation: unknown }>>`
          SELECT operation FROM native_calendar_requests WHERE id = ${target.id}`,
      );
      expect(raw?.operation).toBeTruthy();
      expect(JSON.stringify(raw?.operation)).not.toContain("Example event");
      expect(await inTenant(() => pendingNativeCalendar(db.prisma, otherPhone, botId))).toEqual([]);
      expect(await inTenant(() => claimNativeCalendar(db.prisma, otherPhone, target))).toBeNull();
      const copy = { ...origin, deviceDigest: "not-the-device-key" };
      expect(await inTenant(() => claimNativeCalendar(db.prisma, copy, target))).toBeNull();
      expect(
        await inTenant(() =>
          claimNativeCalendar(db.prisma, origin, { ...target, threadId: "other" }),
        ),
      ).toBeNull();
      expect(
        await inTenant(() => claimNativeCalendar(db.prisma, origin, { ...target, runId: "other" })),
      ).toBeNull();

      const claims = await inTenant(() =>
        Promise.all([
          claimNativeCalendar(db.prisma, origin, target),
          claimNativeCalendar(db.prisma, origin, target),
        ]),
      );
      expect(claims.filter(Boolean)).toHaveLength(1);
      expect(
        await inTenant(() =>
          finishNativeCalendar(deps, origin, target, {
            status: "ok",
            data: { id: "native-event", calendar: { ...calendar, calendarId: "other" } },
          }),
        ),
      ).toBe(false);
      expect(
        await inTenant(() =>
          finishNativeCalendar(deps, otherPhone, target, { status: "cancelled" }),
        ),
      ).toBe(false);
      const saved = { status: "ok", data: { id: "native-event", calendar } } as const;
      expect(await inTenant(() => finishNativeCalendar(deps, origin, target, saved))).toBe(true);
      await expect(result).resolves.toEqual(saved);
      expect(await inTenant(() => finishNativeCalendar(deps, origin, target, saved))).toBe(false);
      expect(
        await inTenant(() => requestNativeCalendar(deps, record, lease, operation, signal.signal)),
      ).toEqual(saved);
    } finally {
      signal.abort();
      await settled;
    }
  }, 20_000);

  it("refuses unattended or device-less runs", async () => {
    const deps = { prisma: db.prisma, events };
    for (const record of [await run("routine"), await run("user", null)]) {
      await expect(
        runAsTenant(identity, () =>
          requestNativeCalendar(deps, record, lease, operation, new AbortController().signal),
        ),
      ).resolves.toEqual({ status: "unavailable" });
    }
  });

  it("deletes a removed account's request even when its run is retained", async () => {
    const record = await run();
    const departing = await system.user.create({
      data: {
        id: randomUUID(),
        email: `departing-${randomUUID()}@example.test`,
        name: "Departing",
      },
    });
    const request = await system.nativeCalendarRequest.create({
      data: {
        id: randomUUID(),
        runId: record.id,
        spaceId: identity.spaceId,
        userId: departing.id,
        sessionId,
        deviceDigest,
        status: "pending",
        operation,
        expiresAt: new Date(0),
      },
    });
    const status = () =>
      contentEncryptionStatus(system).then(({ tables }) =>
        tables.find(({ table }) => table === "native_calendar_requests"),
      );
    const before = await status();
    expect(before?.rows).toBeGreaterThan(0);
    await system.$executeRaw`UPDATE native_calendar_requests SET result = '{"status":"denied"}'::jsonb WHERE id = ${request.id}`;
    expect(await status()).toEqual({ ...before, plaintext: before!.plaintext + 1 });
    await system.user.delete({ where: { id: departing.id } });
    expect(await system.nativeCalendarRequest.findUnique({ where: { id: request.id } })).toBeNull();
    expect(await system.run.findUnique({ where: { id: record.id } })).not.toBeNull();
  });

  it("refuses an expired, shared, or stopped run's request", async () => {
    const record = await run();
    const origin = { userId: identity.userId, spaceId: identity.spaceId, sessionId, deviceDigest };
    const target = { id: randomUUID(), runId: record.id, threadId: identity.threadId };
    const tryClaim = () =>
      runAsTenant(origin, () => claimNativeCalendar(db.prisma, origin, target));
    await system.nativeCalendarRequest.create({
      data: {
        ...origin,
        id: target.id,
        runId: record.id,
        status: "pending",
        operation,
        expiresAt: new Date(0),
      },
    });
    expect(await tryClaim()).toBeNull();
    await pruneExpiredNativeCalendarRequests(db.prisma, new Date());
    expect(
      await system.nativeCalendarRequest.findUnique({ where: { id: target.id } }),
    ).not.toBeNull();
    await system.nativeCalendarRequest.update({
      where: { id: target.id },
      data: { expiresAt: new Date(Date.now() + 60_000) },
    });
    const space = await system.space.findUniqueOrThrow({ where: { id: identity.spaceId } });
    const peer = await system.user.create({
      data: { id: randomUUID(), email: `peer-${randomUUID()}@example.test`, name: "Peer" },
    });
    try {
      await system.member.create({
        data: {
          id: randomUUID(),
          organizationId: space.organizationId,
          userId: peer.id,
          role: "member",
          createdAt: new Date(),
        },
      });
      expect(await tryClaim()).toBeNull();
    } finally {
      await system.user.delete({ where: { id: peer.id } });
    }
    await system.run.update({ where: { id: record.id }, data: { status: "cancelled" } });
    expect(await tryClaim()).toBeNull();
    await pruneExpiredNativeCalendarRequests(db.prisma, new Date());
    expect(
      await system.nativeCalendarRequest.findUnique({ where: { id: target.id } }),
    ).not.toBeNull();
    await pruneExpiredNativeCalendarRequests(db.prisma, new Date(Date.now() + 60_000));
    expect(await system.nativeCalendarRequest.findUnique({ where: { id: target.id } })).toBeNull();
  });
});
