import { randomUUID } from "node:crypto";
import type { MobileDeviceHeartbeatInput, MobileDeviceSummary } from "@rakazo/contracts";
import { MOBILE_DEVICE_HEARTBEAT_MS, MobileDevicePlatformSchema } from "@rakazo/contracts";
import { ClientError } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";

const ONLINE_WINDOW_MS = 3 * MOBILE_DEVICE_HEARTBEAT_MS;

export async function recordMobileDeviceHeartbeat(
  prisma: PrismaClient,
  userId: string,
  nativeSessionId: string | undefined,
  { platform, name }: MobileDeviceHeartbeatInput,
  now = new Date(),
): Promise<void> {
  if (!nativeSessionId) throw new ClientError("UNAUTHORIZED", "A mobile sign-in is required");

  // Lock the live session in the statement that writes presence. A concurrent sign-out either
  // prevents the write or cascades its deletion, so an ended session cannot reconnect itself.
  const written = await prisma.$executeRaw`
    INSERT INTO "mobile_devices" AS device ("id", "sessionId", "platform", "name", "lastSeenAt")
    SELECT ${randomUUID()}, "id", ${platform}, ${name ?? null}, ${now}
    FROM "session"
    WHERE "id" = ${nativeSessionId} AND "userId" = ${userId} AND "expiresAt" > ${now}
    FOR KEY SHARE
    ON CONFLICT ("sessionId") DO UPDATE SET
      "platform" = excluded."platform",
      "name" = excluded."name",
      "lastSeenAt" = GREATEST(device."lastSeenAt", excluded."lastSeenAt")
  `;
  if (!written) throw new ClientError("UNAUTHORIZED", "The mobile sign-in has ended");
}

export async function listMobileDevices(
  prisma: PrismaClient,
  userId: string,
  now = new Date(),
): Promise<MobileDeviceSummary[]> {
  const devices = await prisma.mobileDevice.findMany({
    where: { session: { userId, expiresAt: { gt: now } } },
    select: {
      id: true,
      platform: true,
      name: true,
      lastSeenAt: true,
      session: { select: { expiresAt: true } },
    },
    orderBy: [{ lastSeenAt: "desc" }, { id: "asc" }],
  });
  return devices.map(({ id, platform, name, lastSeenAt, session }) => {
    const onlineUntil = Math.min(
      lastSeenAt.getTime() + ONLINE_WINDOW_MS,
      session.expiresAt.getTime(),
    );
    return {
      deviceId: id,
      platform: MobileDevicePlatformSchema.parse(platform),
      name,
      connected: onlineUntil > now.getTime(),
      onlineUntil: new Date(onlineUntil).toISOString(),
      sessionExpiresAt: session.expiresAt.toISOString(),
    };
  });
}
