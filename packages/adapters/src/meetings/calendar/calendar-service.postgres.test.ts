import { randomUUID } from "node:crypto";
import type { JobPublisher } from "@rakazo/adapter-kit";
import { createDb, runAsSystem, runAsTenant } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { RecallCalendarEmulator } from "../../providers/meeting/recall/calendar-emulator.js";
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
    const service = new MeetingCalendarService({
      prisma,
      provider: emulator.provider,
      jobs,
      webOrigin: "https://rakazo.example.test",
      oauthStateKey: "offline-fixture-key",
      enabled: (space) => space === spaceId,
      buildJoin: (input) => input,
      publish: vi.fn(resolved),
      now: () => now,
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

      const start = await runAsTenant(first, () => service.begin(first, "web"));
      const firstCode = new URL(start.authorizationUrl).searchParams.get("code")!;
      await expect(
        service.completeFromBrowser(second.userId, start.state, firstCode),
      ).rejects.toMatchObject({
        kind: "BAD_REQUEST",
      });
      await service.completeFromBrowser(first.userId, start.state, firstCode);
      const startSecond = await runAsTenant(second, () => service.begin(second, "web"));
      await service.completeFromBrowser(
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
      await runAsTenant(first, () =>
        service.updateSelection(first, botId, firstReview.id, "series"),
      );
      await runAsTenant(second, () =>
        service.updateSelection(second, botId, secondReview.id, "once"),
      );
      const firstConnection = await runAsTenant(first, () =>
        prisma.meetingCalendarConnection.findFirstOrThrow({ where: first }),
      );
      await service.sync(firstConnection.id);
      expect(emulator.scheduled(firstReview.id)).toBeTruthy();
      expect(emulator.scheduled(firstReview.id)).toBe(emulator.scheduled(secondReview.id));
      expect(emulator.scheduled(lastReview.id)).toBeTruthy();
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
      emulator.revision(lastReview.id, { is_deleted: true });
      await service.sync(owner.id);
      expect(emulator.scheduled(lastReview.id)).toBeUndefined();

      const zoom = firstEvents.find(({ platform }) => platform === "zoom")!;
      await runAsTenant(first, () => service.updateSelection(first, botId, zoom.id, "once"));
      const originalBot = emulator.scheduled(zoom.id);
      const revisedLink = "https://zoom.us/j/12345678901?pwd=changed-fixture-password";
      emulator.revision(zoom.id, { meeting_url: revisedLink });
      await service.sync(owner.id);
      expect(emulator.scheduled(zoom.id)).toBe(originalBot);
      expect(emulator.scheduledLink(zoom.id)).toBe(revisedLink);

      await runAsSystem("deactivate the calendar owner", () =>
        prisma.user.update({ where: { id: first.userId }, data: { deactivatedAt: now } }),
      );
      await service.sync(owner.id);
      expect(emulator.scheduled(zoom.id)).toBeUndefined();
      expect((await listing(first)).connected).toBe(false);
      await runAsTenant(second, () => service.disconnect(second));
      expect(emulator.scheduled(secondReview.id)).toBeUndefined();
      expect((await listing(second)).connected).toBe(false);
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
