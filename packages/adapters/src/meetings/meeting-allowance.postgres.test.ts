import { randomUUID } from "node:crypto";
import type { JobPublisher } from "@rakazo/adapter-kit";
import { createDb, createThreadEvents, runAsSystem } from "@rakazo/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MeetingEmulator } from "../providers/meeting/emulator/meeting-emulator.js";
import {
  countSpaceMeetingsForDay,
  countSpaceMeetingsInPastDay,
  MeetingService,
} from "./meeting-service.js";

const databaseUrl = process.env.VERIFY_DATABASE === "1" ? process.env.DATABASE_URL : undefined;
const HOUR = 60 * 60_000;

describe.skipIf(!databaseUrl)("meeting allowance after a bot is deleted (PostgreSQL)", () => {
  const now = new Date("2026-11-18T12:00:00Z");
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps the meetings a deleted bot used counted, but not its upcoming reservations", async () => {
    const { prisma, pool } = createDb(databaseUrl!);
    const resolved = async () => {};
    const jobs: JobPublisher = {
      enqueue: vi.fn(resolved),
      enqueueIn: vi.fn(resolved),
      enqueueManyIn: vi.fn(resolved),
      cancel: vi.fn(resolved),
      cancelIn: vi.fn(resolved),
    } as unknown as JobPublisher;
    const provider = new MeetingEmulator();
    const service = new MeetingService({
      prisma,
      jobs,
      provider,
      events: createThreadEvents(prisma),
    });
    const organizationId = randomUUID();
    const userId = randomUUID();
    const spaceId = randomUUID();
    const botId = randomUUID();
    const tomorrow = new Date("2026-11-19T00:30:00Z");
    const session = (patch: {
      createdAt: Date;
      scheduledFor?: Date;
      status?: string;
      receivedAt?: Date;
    }) => ({
      id: randomUUID(),
      spaceId,
      userId,
      botId,
      platform: "zoom",
      provider: provider.describe().id,
      status: "ended",
      expiresAt: now,
      ...patch,
    });
    try {
      await runAsSystem("seed a bot that used meetings", async () => {
        await prisma.user.create({
          data: { id: userId, email: `${userId}@meeting.example.test`, name: "Fixture" },
        });
        await prisma.organization.create({
          data: { id: organizationId, name: "Fixture", slug: organizationId, createdAt: now },
        });
        await prisma.space.create({ data: { id: spaceId, organizationId, name: "Fixture" } });
        await prisma.bot.create({
          data: { id: botId, userId, spaceId, color: "ink", name: "Atlas" },
        });
        await prisma.meetingSession.createMany({
          data: [
            session({ createdAt: new Date(now.getTime() - HOUR) }),
            session({ createdAt: new Date(now.getTime() - 2 * HOUR) }),
            session({ createdAt: new Date(now.getTime() - 4 * 24 * HOUR) }),
            session({
              createdAt: now,
              scheduledFor: new Date(now.getTime() + 2 * HOUR),
              status: "scheduled",
            }),
            session({ createdAt: now, scheduledFor: tomorrow, receivedAt: now }),
          ],
        });
        await prisma.meetingAllowanceUse.create({
          data: { spaceId, countedAt: new Date(now.getTime() - 5 * 24 * HOUR) },
        });
      });
      const usage = () =>
        runAsSystem("count the Space's meeting usage", async () => ({
          today: await countSpaceMeetingsForDay(prisma, spaceId, now),
          pastDay: await countSpaceMeetingsInPastDay(prisma, spaceId, now),
          tomorrow: await countSpaceMeetingsForDay(prisma, spaceId, tomorrow),
        }));
      expect(await usage()).toEqual({ today: 3, pastDay: 2, tomorrow: 1 });

      await runAsSystem("delete the bot", () =>
        prisma.$transaction(async (tx) => {
          await service.recordBotRetirements(tx, { spaceId, id: botId });
          await tx.bot.delete({ where: { id: botId } });
        }),
      );

      expect(await usage()).toEqual({ today: 2, pastDay: 2, tomorrow: 1 });
      expect(
        await runAsSystem("read kept uses", () =>
          prisma.meetingAllowanceUse.count({ where: { spaceId } }),
        ),
      ).toBe(3);
    } finally {
      await runAsSystem("remove meeting allowance fixture", async () => {
        await prisma.space.deleteMany({ where: { id: spaceId } });
        await prisma.organization.deleteMany({ where: { id: organizationId } });
        await prisma.user.deleteMany({ where: { id: userId } });
      });
      await pool.end();
    }
  });
});
