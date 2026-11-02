import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@rakazo/db";
import { asSystem, createDb, provisionMessagingIdentity, runAsSystem } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  clearRecoveredRoutineDelayAlerts,
  sendRoutineDelayAlert,
  shouldAlertDelayedRoutine,
} from "./routine-delay-alerts.js";

const url = process.env.DATABASE_URL;
const database = process.env.VERIFY_DATABASE === "1" && url ? describe.sequential : describe.skip;

database("routine delay claims (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let system: PrismaClient;
  let identity: { userId: string; spaceId: string; botId: string; threadId: string };
  const address = `routine-alert-${randomUUID()}@rakazo.test`;
  beforeAll(async () => {
    db = createDb(url!);
    system = asSystem(db.prisma);
    const { userId, spaceId, botId, threadId } = await runAsSystem(
      "routine delay alert fixture",
      () =>
        provisionMessagingIdentity(
          db.prisma,
          { provider: "email", address },
          { signupsEnabled: undefined, signupAllowlist: undefined },
        ),
    );
    identity = { userId, spaceId, botId, threadId };
  });
  afterAll(async () => {
    if (identity) {
      await system.messagingIdentity.deleteMany({ where: { address } });
      await system.organization.deleteMany({ where: { id: identity.spaceId } });
      await system.user.deleteMany({ where: { id: identity.userId } });
    }
    if (db) {
      await db.prisma.$disconnect();
      await db.pool.end();
    }
  });

  it("claims one alert across detectors and clears the episode after recovery", async () => {
    const now = new Date("2026-11-01T06:30:00Z");
    const nextRunAt = new Date("2026-11-01T06:00:00Z");
    const row = await system.routine.create({
      data: {
        ...identity,
        name: "Report",
        prompt: "Report",
        crons: ["0 * * * *"],
        active: true,
        delayAlertsEnabled: true,
        nextRunAt,
      },
    });
    const deliver = vi.fn(async () => "delivered" as const);
    const alert = { ...row, threadId: identity.threadId };
    await Promise.all([
      sendRoutineDelayAlert(system, deliver, alert, now),
      sendRoutineDelayAlert(system, deliver, alert, now),
    ]);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(await system.routine.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({
      delayAlertResult: "sent",
      delayAlertSchedule: nextRunAt,
    });
    await system.routine.update({
      where: { id: row.id },
      data: { nextRunAt: new Date("2026-11-01T07:00:00Z") },
    });
    await clearRecoveredRoutineDelayAlerts(system, now);
    expect(await system.routine.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({
      delayAlertResult: null,
      delayAlertSchedule: null,
      delayAlertSentAt: now,
    });
  });

  it("records an unavailable recipient and delays another attempt", async () => {
    const now = new Date("2026-11-01T06:30:00Z");
    const row = await system.routine.create({
      data: {
        ...identity,
        name: "Report",
        prompt: "Report",
        crons: ["0 * * * *"],
        active: true,
        delayAlertsEnabled: true,
        nextRunAt: new Date("2026-11-01T06:00:00Z"),
      },
    });
    await sendRoutineDelayAlert(
      system,
      async () => "undeliverable",
      { ...row, threadId: identity.threadId },
      now,
    );
    const saved = await system.routine.findUniqueOrThrow({ where: { id: row.id } });
    expect(saved.delayAlertResult).toBe("failed");
    expect(shouldAlertDelayedRoutine(saved, now)).toBe(false);
    expect(shouldAlertDelayedRoutine(saved, new Date(now.getTime() + 60 * 60_000))).toBe(true);
  });
});
