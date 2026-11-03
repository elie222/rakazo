import type { UserDeviceHub, UserDeviceRevokeReason, UserDevices } from "@rakazo/adapters";
import {
  createUserDeviceToken,
  hashUserDeviceToken,
  USER_DEVICE_DISCONNECT_PATH,
  USER_DEVICE_FORWARD_PATH,
  USER_DEVICE_LIMIT,
  userDeviceDisconnectBody,
  userDeviceForwardBody,
  validUserDeviceForwardSecret,
} from "@rakazo/adapters";
import type { UserDeviceList, UserDevicePairResponse } from "@rakazo/contracts";
import {
  USER_DEVICE_CONNECT_PATH,
  USER_DEVICE_PAIR_PATH,
  USER_DEVICE_PATH,
  userDevicePairRequest,
} from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { recordSecurityEvent, runAsSystem } from "@rakazo/db";
import type { Hono } from "hono";
import { readBoundedBody } from "./http-body.js";

const FORWARD_BODY_MAX_BYTES = 13 * 1024 * 1024;

export interface UserDeviceRouteDeps {
  prisma: PrismaClient;
  hub: UserDeviceHub;
  devices: UserDevices;
  forwardSecret: string;
  session: (request: Request) => Promise<{ userId: string; sessionId: string } | null>;
  trustedOrigin: (origin: string) => boolean;
}

type DeviceStore = { prisma: PrismaClient; devices: UserDevices };

async function revokeDevice(
  { prisma, devices }: DeviceStore,
  deviceId: string,
  userId: string,
  by: "owner" | "device" | "session",
) {
  const { count } = await runAsSystem("revoke a user device", () =>
    prisma.userDevice.updateMany({
      where: { id: deviceId, userId, revokedAt: null },
      data: { revokedAt: new Date() },
    }),
  );
  if (!count) return false;
  await recordSecurityEvent({ type: "device.revoked", userId, metadata: { deviceId, by } });
  const reason: UserDeviceRevokeReason | undefined = by === "session" ? "session-ended" : undefined;
  await devices.disconnect(deviceId, reason);
  return true;
}

/**
 * A computer stays paired only while the sign-in that paired it lasts, so signing out, a password
 * reset or signing out everywhere disconnects it. A password change that keeps the caller signed
 * in moves the caller's computers to the replacing session. Computers paired before sessions were
 * recorded end with the user's next session.
 */
export async function endUserDeviceSession(
  store: DeviceStore,
  ended: { id: string; userId: string },
  next?: { id: string },
) {
  const { prisma } = store;
  const { userId } = ended;
  if (next) {
    await runAsSystem("move user devices to a new session", () =>
      prisma.userDevice.updateMany({
        where: { userId, sessionId: ended.id, revokedAt: null },
        data: { sessionId: next.id },
      }),
    );
    return;
  }
  const devices = await runAsSystem("find a session's user devices", () =>
    prisma.userDevice.findMany({
      where: { userId, revokedAt: null, OR: [{ sessionId: ended.id }, { sessionId: null }] },
      select: { id: true },
    }),
  );
  for (const device of devices) await revokeDevice(store, device.id, userId, "session");
}

/** The device socket itself is upgraded by the hub before Hono sees it. */
export function mountUserDeviceRoutes(app: Hono, deps: UserDeviceRouteDeps) {
  const { prisma } = deps;
  app.use(`${USER_DEVICE_PATH}/*`, async (c, next) => {
    await next();
    c.header("cache-control", "no-store");
  });

  app.post(USER_DEVICE_PAIR_PATH, async (c) => {
    // The desktop main process sends no Origin. A JSON content type forces a CORS preflight,
    // so a cross-site page cannot pair with the user's cookie either way.
    const origin = c.req.header("origin");
    if (origin && !deps.trustedOrigin(origin)) return c.json({ error: "Forbidden" }, 403);
    if (!c.req.header("content-type")?.startsWith("application/json"))
      return c.json({ error: "Expected JSON" }, 415);
    const session = await deps.session(c.req.raw);
    if (!session) return c.json({ error: "Unauthorized" }, 401);
    const { userId, sessionId } = session;
    const body = await readBoundedBody(c.req.raw, 4096);
    if (body === null) return c.json({ error: "Request too large" }, 413);
    const input = userDevicePairRequest.safeParse(parseJson(body));
    if (!input.success) return c.json({ error: "Invalid device" }, 400);
    const token = createUserDeviceToken();
    const device = await runAsSystem("pair a user device", async () => {
      const active = await prisma.userDevice.count({ where: { userId, revokedAt: null } });
      if (active >= USER_DEVICE_LIMIT) return null;
      return prisma.userDevice.create({
        data: {
          userId,
          name: input.data.name,
          platform: input.data.platform,
          tokenHash: hashUserDeviceToken(token),
          sessionId,
        },
        select: { id: true },
      });
    });
    if (!device) return c.json({ error: "Remove a computer before adding another" }, 409);
    await recordSecurityEvent({
      type: "device.paired",
      userId,
      metadata: { deviceId: device.id, platform: input.data.platform },
    });
    return c.json({ deviceId: device.id, userId, token } satisfies UserDevicePairResponse, 201);
  });

  app.get(USER_DEVICE_PATH, async (c) => {
    const session = await deps.session(c.req.raw);
    if (!session) return c.json({ error: "Unauthorized" }, 401);
    return c.json({
      devices: await deps.devices.list(session.userId),
    } satisfies UserDeviceList);
  });

  app.get(USER_DEVICE_CONNECT_PATH, (c) => c.json({ error: "Upgrade required" }, 426));

  // Registered before `:deviceId` so "self" is never read as an id.
  app.delete(`${USER_DEVICE_PATH}/self`, async (c) => {
    const device = await deps.hub.authenticate(c.req.header("authorization"));
    if (!device) return c.json({ error: "Unauthorized" }, 401);
    await revokeDevice(deps, device.id, device.userId, "device");
    return c.body(null, 204);
  });

  app.delete(`${USER_DEVICE_PATH}/:deviceId`, async (c) => {
    const session = await deps.session(c.req.raw);
    if (!session) return c.json({ error: "Unauthorized" }, 401);
    const revoked = await revokeDevice(deps, c.req.param("deviceId"), session.userId, "owner");
    return revoked ? c.body(null, 204) : c.json({ error: "Not found" }, 404);
  });

  app.post(USER_DEVICE_FORWARD_PATH, async (c) => {
    if (!validUserDeviceForwardSecret(deps.forwardSecret, c.req.header("authorization")))
      return c.json({ error: "Unauthorized" }, 401);
    const body = await readBoundedBody(c.req.raw, FORWARD_BODY_MAX_BYTES);
    if (body === null) return c.json({ error: "Request too large" }, 413);
    const input = userDeviceForwardBody.safeParse(parseJson(body));
    if (!input.success) return c.json({ error: "Invalid request" }, 400);
    const { request, ...route } = input.data;
    return deps.hub.stream(route, request, c.req.raw.signal);
  });

  app.post(USER_DEVICE_DISCONNECT_PATH, async (c) => {
    if (!validUserDeviceForwardSecret(deps.forwardSecret, c.req.header("authorization")))
      return c.json({ error: "Unauthorized" }, 401);
    const body = await readBoundedBody(c.req.raw, 1024);
    const input = userDeviceDisconnectBody.safeParse(parseJson(body ?? ""));
    if (!input.success) return c.json({ error: "Invalid request" }, 400);
    deps.hub.disconnect(input.data.deviceId, input.data.reason);
    return c.body(null, 204);
  });
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}
