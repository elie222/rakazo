import { EventEmitter } from "node:events";
import type { UserDeviceSocket } from "@rakazo/adapters";
import {
  hashUserDeviceToken,
  USER_DEVICE_FORWARD_PATH,
  UserDeviceHub,
  UserDevices,
  userDeviceForwardSecret,
} from "@rakazo/adapters";
import type { PrismaClient } from "@rakazo/db";
import { installSecurityEventStore } from "@rakazo/db";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { mountUserDeviceRoutes } from "./user-devices.js";

interface Row {
  id: string;
  userId: string;
  name: string;
  platform: string;
  tokenHash: string;
  createdAt: Date;
  lastSeenAt: Date | null;
  revokedAt: Date | null;
}

function fakePrisma() {
  const rows: Row[] = [];
  const connections = new Map<string, Date>();
  const events: Array<{ type: string; userId: string | null; metadata: object }> = [];
  const matches = (row: Row, where: Partial<Row>) =>
    Object.entries(where).every(([key, value]) => row[key as keyof Row] === value);
  const prisma = {
    userDevice: {
      count: async ({ where }: { where: Partial<Row> }) =>
        rows.filter((row) => matches(row, where)).length,
      create: async ({
        data,
      }: {
        data: Omit<Row, "id" | "createdAt" | "lastSeenAt" | "revokedAt"> &
          Partial<Pick<Row, "lastSeenAt" | "revokedAt">>;
      }) => {
        const row = {
          id: `device-${rows.length + 1}`,
          createdAt: new Date(),
          lastSeenAt: null,
          revokedAt: null,
          ...data,
        };
        rows.push(row);
        return { id: row.id };
      },
      findMany: async ({
        where,
        select,
      }: {
        where: Partial<Row>;
        select?: { connections?: { where: { heartbeatAt: { gt: Date } } } };
      }) =>
        rows
          .filter((row) => matches(row, where))
          .map((row) => {
            const after = select?.connections?.where.heartbeatAt.gt;
            const heartbeatAt = connections.get(row.id);
            return {
              ...row,
              connections:
                after && heartbeatAt && heartbeatAt > after ? [{ deviceId: row.id }] : [],
            };
          }),
      findUnique: async ({ where }: { where: { tokenHash: string } }) =>
        rows.find((row) => row.tokenHash === where.tokenHash) ?? null,
      update: async () => ({}),
      updateMany: async ({ where, data }: { where: Partial<Row>; data: Partial<Row> }) => {
        const hit = rows.filter((row) => matches(row, where));
        for (const row of hit) Object.assign(row, data);
        return { count: hit.length };
      },
    },
    userDeviceConnection: {
      upsert: async ({ create }: { create: { deviceId: string; heartbeatAt: Date } }) =>
        connections.set(create.deviceId, create.heartbeatAt),
      deleteMany: async () => ({ count: 0 }),
      findFirst: async () => null,
      findUnique: async () => null,
    },
    securityEvent: {
      create: async ({ data }: { data: (typeof events)[number] }) => events.push(data),
    },
    $transaction: (run: (tx: unknown) => Promise<unknown>) => run(prisma),
  };
  return { prisma: prisma as unknown as PrismaClient, rows, events, connections };
}

class FakeSocket extends EventEmitter implements UserDeviceSocket {
  sent: unknown[] = [];
  closedWith?: number;
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close(code?: number) {
    this.closedWith = code;
    this.emit("close");
  }
  ping() {}
  terminate() {
    this.close();
  }
}

const secret = userDeviceForwardSecret("test-key");
const hubs: UserDeviceHub[] = [];

function setup() {
  const db = fakePrisma();
  installSecurityEventStore(db.prisma);
  const hub = new UserDeviceHub({ prisma: db.prisma, address: "http://127.0.0.1:3100" });
  hubs.push(hub);
  const app = new Hono();
  mountUserDeviceRoutes(app, {
    prisma: db.prisma,
    hub,
    devices: new UserDevices({ prisma: db.prisma, forwardSecret: secret, hub }),
    forwardSecret: secret,
    sessionUserId: async (request) => request.headers.get("x-test-user"),
    trustedOrigin: (origin) => origin === "http://app.test",
  });
  const pair = (user: string | null, init: { origin?: string; body?: unknown } = {}) =>
    app.request("/api/devices/pair", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(user ? { "x-test-user": user } : {}),
        ...(init.origin ? { origin: init.origin } : {}),
      },
      body: JSON.stringify(init.body ?? { name: "Laptop", platform: "darwin" }),
    });
  return { ...db, hub, app, pair };
}

afterEach(async () => {
  installSecurityEventStore(undefined);
  await Promise.all(hubs.splice(0).map((hub) => hub.close()));
});

describe("device pairing", () => {
  it("requires a session and a JSON body, and refuses a foreign origin", async () => {
    const { pair, app } = setup();
    expect((await pair(null)).status).toBe(401);
    expect((await pair("user-1", { origin: "https://evil.test" })).status).toBe(403);
    expect((await pair("user-1", { body: { name: "", platform: "darwin" } })).status).toBe(400);
    const form = await app.request("/api/devices/pair", {
      method: "POST",
      headers: { "content-type": "text/plain", "x-test-user": "user-1" },
      body: JSON.stringify({ name: "Laptop", platform: "darwin" }),
    });
    expect(form.status).toBe(415);
  });

  it("returns the token once and stores only its hash", async () => {
    const { pair, rows, events } = setup();
    const response = await pair("user-1", { origin: "http://app.test" });
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const { deviceId, token } = await response.json();
    expect(token).toMatch(/^[a-f0-9]{64}$/);
    expect(rows).toEqual([expect.objectContaining({ id: deviceId, userId: "user-1" })]);
    expect(rows[0]!.tokenHash).toBe(hashUserDeviceToken(token));
    expect(JSON.stringify(rows)).not.toContain(token);
    expect(events).toEqual([
      expect.objectContaining({
        type: "device.paired",
        userId: "user-1",
        metadata: { deviceId, platform: "darwin" },
      }),
    ]);
    expect(JSON.stringify(events)).not.toContain(token);
  });

  it("caps active devices per user", async () => {
    const { pair } = setup();
    for (let index = 0; index < 10; index += 1) expect((await pair("user-1")).status).toBe(201);
    expect((await pair("user-1")).status).toBe(409);
    expect((await pair("user-2")).status).toBe(201);
  });

  it("lists the user's own active devices", async () => {
    const { pair, app } = setup();
    await pair("user-1");
    await pair("user-2");
    const response = await app.request("/api/devices", { headers: { "x-test-user": "user-1" } });
    const { devices } = await response.json();
    expect(devices).toEqual([
      expect.objectContaining({ deviceId: "device-1", name: "Laptop", connected: false }),
    ]);
    expect(JSON.stringify(devices)).not.toContain("tokenHash");
  });

  it("shows each device's own live connection", async () => {
    const { pair, app, hub, connections } = setup();
    await pair("user-1");
    await pair("user-1");
    await pair("user-1");
    for (const id of ["device-1", "device-2"])
      await hub.attach(
        { id, userId: "user-1", name: "Laptop", platform: "darwin" },
        new FakeSocket(),
      );
    connections.set("device-2", new Date(Date.now() - 10 * 60_000));
    const response = await app.request("/api/devices", { headers: { "x-test-user": "user-1" } });
    const { devices } = await response.json();
    expect(
      Object.fromEntries(
        devices.map((device: { deviceId: string; connected: boolean }) => [
          device.deviceId,
          device.connected,
        ]),
      ),
    ).toEqual({ "device-1": true, "device-2": false, "device-3": false });
  });
});

describe("device revoke", () => {
  it("lets only the owner revoke, then closes the socket and records it", async () => {
    const { pair, app, hub, rows, events } = setup();
    const { deviceId } = await (await pair("user-1")).json();
    const socket = new FakeSocket();
    await hub.attach(
      { id: deviceId, userId: "user-1", name: "Laptop", platform: "darwin" },
      socket,
    );
    const remove = (user: string) =>
      app.request(`/api/devices/${deviceId}`, {
        method: "DELETE",
        headers: { "x-test-user": user },
      });
    expect((await remove("user-2")).status).toBe(404);
    expect(rows[0]!.revokedAt).toBeNull();
    expect((await remove("user-1")).status).toBe(204);
    expect(rows[0]!.revokedAt).toBeInstanceOf(Date);
    expect(socket.sent).toContainEqual({ type: "revoked" });
    expect(socket.closedWith).toBe(4001);
    expect(events.at(-1)).toMatchObject({ type: "device.revoked", metadata: { deviceId } });
    expect((await remove("user-1")).status).toBe(404);
  });

  it("lets a device revoke itself with its token, which then stops working", async () => {
    const { pair, app, hub } = setup();
    const { token } = await (await pair("user-1")).json();
    const self = () =>
      app.request("/api/devices/self", {
        method: "DELETE",
        headers: { authorization: `Bearer ${token}` },
      });
    expect((await self()).status).toBe(204);
    await expect(hub.authenticate(`Bearer ${token}`)).resolves.toBeNull();
    expect((await self()).status).toBe(401);
  });
});

describe("internal forwarding endpoint", () => {
  it("requires the derived forward secret", async () => {
    const { app } = setup();
    const forward = (authorization: string) =>
      app.request(USER_DEVICE_FORWARD_PATH, {
        method: "POST",
        headers: { authorization, "content-type": "application/json" },
        body: JSON.stringify({
          deviceId: "device-1",
          userId: "user-1",
          connectionId: "c",
          request: { method: "environment", botId: "bot-1" },
        }),
      });
    expect((await forward("Bearer wrong")).status).toBe(401);
    // Authorized, but this process holds no such connection.
    expect((await forward(`Bearer ${secret}`)).status).toBe(409);
  });
});
