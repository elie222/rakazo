import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@rakazo/db";
import { asSystem, createDb, runAsTenant } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listMobileDevices, recordMobileDeviceHeartbeat } from "./mobile-devices.js";

const databaseUrl = process.env.DATABASE_URL;
const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(databaseUrl);

describe.skipIf(!enabled)("mobile device presence (PostgreSQL)", () => {
  const now = new Date("2030-01-01T12:00:00.000Z");
  const userId = randomUUID();
  const otherUserId = randomUUID();
  let db: ReturnType<typeof createDb>;
  let fixtures: PrismaClient;

  const asUser = <T>(userId: string, operation: () => T | PromiseLike<T>) =>
    runAsTenant({ userId, spaceId: "device-test-space" }, operation);

  beforeAll(async () => {
    db = createDb(databaseUrl!);
    fixtures = asSystem(db.prisma);
    await fixtures.user.createMany({
      data: [userId, otherUserId].map((id) => ({
        id,
        name: "Mobile presence",
        email: `${id}@rakazo.test`,
      })),
    });
  });

  afterAll(async () => {
    await fixtures.user.deleteMany({ where: { id: { in: [userId, otherUserId] } } });
    await db.prisma.$disconnect();
    await db.pool.end();
  });

  function signIn(userId: string) {
    return fixtures.session.create({
      data: {
        id: randomUUID(),
        token: randomUUID(),
        userId,
        expiresAt: new Date("2030-01-02T12:00:00.000Z"),
      },
    });
  }

  it("updates one device per session and keeps it listed when the heartbeat goes stale", async () => {
    const { id } = await signIn(userId);
    await asUser(userId, () =>
      recordMobileDeviceHeartbeat(db.prisma, userId, id, { platform: "android" }, now),
    );
    await asUser(userId, () =>
      recordMobileDeviceHeartbeat(
        db.prisma,
        userId,
        id,
        { platform: "android", name: "Test phone" },
        new Date("2030-01-01T12:00:30.000Z"),
      ),
    );
    const list = (at: Date) => asUser(userId, () => listMobileDevices(db.prisma, userId, at));
    const [device] = await list(new Date("2030-01-01T12:01:59.999Z"));
    expect(device).toEqual({
      deviceId: expect.any(String),
      platform: "android",
      name: "Test phone",
      connected: true,
      onlineUntil: "2030-01-01T12:02:00.000Z",
    });
    expect(device?.deviceId).not.toBe(id);
    await expect(list(new Date("2030-01-01T12:02:00.000Z"))).resolves.toEqual([
      { ...device, connected: false },
    ]);
    await fixtures.session.delete({ where: { id } });
    await expect(
      fixtures.mobileDevice.findUnique({ where: { sessionId: id } }),
    ).resolves.toBeNull();
  });

  it("rejects a heartbeat sent under a different account from the session", async () => {
    const { id } = await signIn(otherUserId);
    await expect(
      asUser(userId, () =>
        recordMobileDeviceHeartbeat(db.prisma, userId, id, { platform: "ios" }, now),
      ),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});
