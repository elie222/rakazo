import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createUserDeviceToken,
  EmailEmulator,
  FakeSandboxProvider,
  hashUserDeviceToken,
  USER_DEVICE_LIMIT,
} from "@rakazo/adapters";
import {
  USER_DEVICE_PAIR_PATH,
  USER_DEVICE_PATH,
  USER_DEVICE_SESSION_PATH,
  userDeviceListSchema,
} from "@rakazo/contracts";
import { deferred } from "@rakazo/core/test-async";
import { lockOwner, runAsSystem } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { sessionCookieHeader } from "../../../../packages/testkit/src/index.js";
import type { AppHandles } from "../app.js";
import { createApp } from "../app.js";

const databaseUrl = process.env.VERIFY_DATABASE === "1" ? process.env.DATABASE_URL : undefined;
const webOrigin = "http://127.0.0.1:5173";

describe.skipIf(!databaseUrl)("paired computers end with the sign-in that paired them", () => {
  let handles: AppHandles;
  let dataDir: string;
  const email = new EmailEmulator();
  const stamp = Date.now();
  let account = 0;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "rakazo-device-sessions-"));
    handles = await createApp({
      databaseUrl: databaseUrl!,
      dataDir,
      sandboxProvider: "fake",
      sandbox: new FakeSandboxProvider(),
      agentRuntime: "scripted",
      wakeupDriver: "memory",
      signupsEnabled: "true",
      signupAllowlist: "",
      webOrigin,
      authUrl: webOrigin,
      email,
    });
  });

  afterAll(async () => {
    await handles?.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  async function auth(path: string, body: object, cookie = "") {
    const response = await handles.app.request(`/api/auth${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: webOrigin,
        ...(cookie ? { cookie } : {}),
      },
      body: JSON.stringify(body),
    });
    expect(response.status, `${path}: ${await response.clone().text()}`).toBe(200);
    return response;
  }

  async function newAccount() {
    const address = `device-sessions-${stamp}-${++account}@example.test`;
    const password = "test-password-123";
    await auth("/sign-up/email", { email: address, password, name: "Owner" });
    const signIn = async (current = password) =>
      sessionCookieHeader(await auth("/sign-in/email", { email: address, password: current }));
    return { address, password, signIn };
  }

  /** What the desktop app does with the window's sign-in. */
  async function pair(cookie: string, pairingKey?: string) {
    const response = await handles.app.request(USER_DEVICE_PAIR_PATH, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ name: "Desktop", platform: "darwin", pairingKey }),
    });
    expect(response.status).toBe(201);
    return (await response.json()) as { deviceId: string; token: string; userId: string };
  }

  /** Revokes the device when its token still works, so call it only to show that it does not. */
  const active = async (token: string) => {
    const response = await handles.app.request(`${USER_DEVICE_PATH}/self`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}` },
    });
    return response.status !== 401;
  };
  const revokedAt = (deviceId: string) =>
    runAsSystem("read a paired computer", () =>
      handles.prisma.userDevice.findUniqueOrThrow({ where: { id: deviceId } }),
    ).then((device) => device.revokedAt);

  const deviceState = (id: string) =>
    runAsSystem("read the device lifecycle for the paired device", () =>
      handles.prisma.userDevice.findUniqueOrThrow({
        where: { id },
        select: { sessionId: true, revokedAt: true, revokedBy: true },
      }),
    );

  async function deviceFixture(
    userId: string,
    kind: "computer" | "mobile",
    sessionId: string | null,
  ) {
    const token = createUserDeviceToken();
    const { id } = await runAsSystem("insert an paired device fixture", () =>
      handles.prisma.userDevice.create({
        data: {
          userId,
          kind,
          sessionId,
          name: "Fixture",
          platform: "darwin",
          createdAt: new Date("2000-01-01T00:00:00Z"),
          tokenHash: hashUserDeviceToken(token),
        },
        select: { id: true },
      }),
    );
    return { id, token };
  }

  it("lists, binds and removes the owner's computers among same-platform mixed devices", async () => {
    const owner = await newAccount();
    const cookie = await owner.signIn();
    const mine = await pair(cookie);
    const other = await pair(await (await newAccount()).signIn());
    const otherBefore = await deviceState(other.deviceId);
    const mineBefore = await deviceState(mine.deviceId);
    const mobile = await deviceFixture(mine.userId, "mobile", null);
    const legacy = await deviceFixture(mine.userId, "computer", null);
    const mobileBefore = await deviceState(mobile.id);

    const list = await handles.app.request(USER_DEVICE_PATH, { headers: { cookie } });
    expect(list.status).toBe(200);
    const { devices } = userDeviceListSchema.parse(await list.json());
    expect(devices.map((row) => row.deviceId)).toEqual([mine.deviceId, legacy.id]);
    expect(mineBefore.sessionId).toEqual(expect.any(String));
    const tied = await handles.app.request(USER_DEVICE_SESSION_PATH, {
      method: "POST",
      headers: { cookie, authorization: `Bearer ${legacy.token}` },
    });
    expect(tied.status).toBe(204);
    expect(await deviceState(legacy.id)).toEqual(mineBefore);
    const mobileRemoval = await handles.app.request(`${USER_DEVICE_PATH}/${mobile.id}`, {
      method: "DELETE",
      headers: { cookie },
    });
    expect(mobileRemoval.status).toBe(404);
    expect(await deviceState(mobile.id)).toEqual(mobileBefore);
    const removed = await handles.app.request(`${USER_DEVICE_PATH}/${legacy.id}`, {
      method: "DELETE",
      headers: { cookie },
    });
    expect(removed.status).toBe(204);
    expect(await deviceState(legacy.id)).toEqual({
      sessionId: mineBefore.sessionId,
      revokedBy: "owner",
      revokedAt: expect.any(Date),
    });
    expect(await deviceState(other.deviceId)).toEqual(otherBefore);
    expect(await deviceState(mine.deviceId)).toEqual(mineBefore);
  });

  it("signing out ends only the computer that sign-in paired", async () => {
    const owner = await newAccount();
    const desktop = await owner.signIn();
    const phone = await owner.signIn();
    const device = await pair(desktop);
    const other = await pair(await owner.signIn());

    await auth("/sign-out", {}, phone);
    expect(await revokedAt(device.deviceId)).toBeNull();

    await auth("/sign-out", {}, desktop);
    expect(await revokedAt(device.deviceId)).toBeInstanceOf(Date);
    expect(await revokedAt(other.deviceId)).toBeNull();

    // Signing back in pairs again for the same account.
    const again = await pair(await owner.signIn());
    expect(again.userId).toBe(device.userId);
    expect(await revokedAt(again.deviceId)).toBeNull();
  });

  it("signing out everywhere ends every paired computer", async () => {
    const owner = await newAccount();
    const devices = [await pair(await owner.signIn()), await pair(await owner.signIn())];
    await auth("/revoke-sessions", {}, await owner.signIn());
    for (const device of devices) expect(await active(device.token)).toBe(false);
  });

  it("signing out everywhere removes the pages installed as apps, even with no other session", async () => {
    const owner = await newAccount();
    const cookie = await owner.signIn();
    const { userId } = await pair(cookie);
    // Nothing is left to sign out after this, so only the request itself can end the apps.
    await auth("/revoke-other-sessions", {}, cookie);
    await runAsSystem("install a page app", async () => {
      const { spaceId } = await handles.prisma.spaceMember.findFirstOrThrow({ where: { userId } });
      await handles.prisma.page.create({
        data: {
          spaceId,
          userId,
          title: "Deals",
          apps: { create: { userId, spaceId, tokenHash: `hash-${stamp}-${account}` } },
        },
      });
    });
    const apps = () =>
      runAsSystem("count page apps", () => handles.prisma.pageApp.count({ where: { userId } }));
    expect(await apps()).toBe(1);
    await auth("/revoke-other-sessions", {}, cookie);
    expect(await apps()).toBe(0);
  });

  it("a password change replaces the caller session and ends other sessions for both device kinds", async () => {
    const owner = await newAccount();
    const attacker = await pair(await owner.signIn());
    const desktop = await owner.signIn();
    const mine = await pair(desktop);
    const mineBefore = (await deviceState(mine.deviceId)).sessionId;
    const attackerBefore = (await deviceState(attacker.deviceId)).sessionId;
    expect(mineBefore).toEqual(expect.any(String));
    expect(attackerBefore).toEqual(expect.any(String));
    const mineMobile = await deviceFixture(mine.userId, "mobile", mineBefore);
    const attackerMobile = await deviceFixture(attacker.userId, "mobile", attackerBefore);
    await auth(
      "/change-password",
      {
        currentPassword: owner.password,
        newPassword: "test-password-456",
        revokeOtherSessions: true,
      },
      desktop,
    );
    expect(await deviceState(attacker.deviceId)).toMatchObject({
      revokedAt: expect.any(Date),
      revokedBy: "session",
    });
    expect(await deviceState(attackerMobile.id)).toMatchObject({
      revokedAt: expect.any(Date),
      revokedBy: "session",
    });
    expect(await revokedAt(mine.deviceId)).toBeNull();
    const moved = await runAsSystem("read a paired computer", () =>
      handles.prisma.userDevice.findUniqueOrThrow({ where: { id: mine.deviceId } }),
    );
    expect(moved.sessionId).not.toBe(mineBefore);
    expect(await deviceState(mineMobile.id)).toEqual({
      sessionId: moved.sessionId,
      revokedAt: null,
      revokedBy: null,
    });
    const sessions = await runAsSystem("read sessions", () =>
      handles.prisma.session.findMany({ where: { userId: mine.userId }, select: { id: true } }),
    );
    expect(sessions.map((session) => session.id)).toContain(moved.sessionId);
  });

  it("refuses a pairing authenticated before a concurrent password change", async () => {
    const owner = await newAccount();
    const desktop = await owner.signIn();
    const first = await pair(desktop);
    const held = deferred<number>();
    const release = deferred<void>();
    const holding = runAsSystem("hold the pairing lock during session replacement", () =>
      handles.prisma.$transaction(
        async (tx) => {
          await lockOwner(tx, first.userId, "user-devices");
          const [row] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
          held.resolve(row!.pid);
          await release.promise;
        },
        { timeout: 20_000 },
      ),
    );
    const pid = await held.promise;
    const waitForBlocked = (count: number) =>
      vi.waitFor(
        async () => {
          const [row] = await runAsSystem(
            "wait for pairing and cleanup behind the held lock",
            () =>
              handles.prisma.$queryRaw<Array<{ count: number }>>`
          WITH RECURSIVE queued(pid) AS (
            SELECT pid FROM pg_stat_activity
            WHERE datname = current_database() AND ${pid}::int = ANY(pg_blocking_pids(pid))
            UNION
            SELECT a.pid FROM pg_stat_activity a JOIN queued q ON q.pid = ANY(pg_blocking_pids(a.pid))
            WHERE a.datname = current_database()
          ) SELECT count(*)::int AS count FROM queued`,
          );
          expect(row?.count).toBeGreaterThanOrEqual(count);
        },
        { timeout: 10_000 },
      );
    let pending: Promise<Response> | undefined;
    let changing: Promise<Response> | undefined;
    try {
      pending = Promise.resolve(
        handles.app.request(USER_DEVICE_PAIR_PATH, {
          method: "POST",
          headers: { "content-type": "application/json", cookie: desktop },
          body: JSON.stringify({ name: "Pending", platform: "darwin", pairingKey: "a".repeat(64) }),
        }),
      );
      await waitForBlocked(1);
      changing = auth(
        "/change-password",
        {
          currentPassword: owner.password,
          newPassword: "test-password-456",
          revokeOtherSessions: true,
        },
        desktop,
      );
      await waitForBlocked(2);
    } finally {
      release.resolve();
      await holding;
    }
    expect((await pending!).status).toBe(401);
    const replacement = sessionCookieHeader(await changing!);
    const devices = await runAsSystem("read devices after the concurrent password change", () =>
      handles.prisma.userDevice.findMany({ where: { userId: first.userId, revokedAt: null } }),
    );
    expect(devices).toHaveLength(1);
    expect(devices[0]?.id).toBe(first.deviceId);
    expect(await pair(replacement, "a".repeat(64))).toMatchObject({ userId: first.userId });
  });

  it.each([1, USER_DEVICE_LIMIT])(
    "recovers a lost pairing after a password change with %i active devices",
    async (count) => {
      const owner = await newAccount();
      const desktop = await owner.signIn();
      const pairingKey = "f".repeat(64);
      const first = await pair(desktop, pairingKey);
      for (let index = 1; index < count; index += 1) await pair(desktop);
      const changed = await auth(
        "/change-password",
        {
          currentPassword: owner.password,
          newPassword: "test-password-456",
          revokeOtherSessions: true,
        },
        desktop,
      );
      const replacement = sessionCookieHeader(changed);
      expect(replacement).not.toBe("");
      expect(await pair(replacement, pairingKey)).toEqual(first);
      const devices = await runAsSystem("count paired computers after password change", () =>
        handles.prisma.userDevice.count({ where: { userId: first.userId, revokedAt: null } }),
      );
      expect(devices).toBe(count);
    },
  );

  it("a password reset ends both device kinds, including devices without a session", async () => {
    const owner = await newAccount();
    const attacker = await pair(await owner.signIn());
    const legacy = await pair(await owner.signIn());
    await runAsSystem("forget the pairing session", () =>
      handles.prisma.userDevice.update({
        where: { id: legacy.deviceId },
        data: { sessionId: null },
      }),
    );

    const sessionId = (await deviceState(attacker.deviceId)).sessionId;
    expect(sessionId).toEqual(expect.any(String));
    const mobile = await deviceFixture(attacker.userId, "mobile", sessionId);
    const legacyMobile = await deviceFixture(attacker.userId, "mobile", null);

    const linkTo = async (path: string) =>
      vi.waitFor(() => {
        const link = email.sent
          .filter((message) => message.to === owner.address)
          .map((message) => message.text.match(new RegExp(`https?://\\S*${path}\\S*`))?.[0])
          .find(Boolean);
        if (!link) throw new Error(`No ${path} email yet`);
        return new URL(link);
      });
    // Only a proven address can be reset.
    const verify = await linkTo("/verify-email");
    await handles.app.request(verify.pathname + verify.search);
    await auth("/request-password-reset", {
      email: owner.address,
      redirectTo: `${webOrigin}/reset-password`,
    });
    const resetToken = (await linkTo("/reset-password/")).pathname.split("/").at(-1);
    await auth("/reset-password", { token: resetToken, newPassword: "test-password-789" });

    expect(await active(attacker.token)).toBe(false);
    expect(await active(legacy.token)).toBe(false);
    for (const { id } of [mobile, legacyMobile]) {
      expect(await deviceState(id)).toMatchObject({
        revokedAt: expect.any(Date),
        revokedBy: "session",
      });
    }
  });

  it("releases a computer whose sign-in ended while it was offline", async () => {
    const owner = await newAccount();
    const desktop = await owner.signIn();
    const device = await pair(desktop);
    // Expired, or deleted without the sign-out hook: no revocation ran.
    await runAsSystem("expire the pairing sign-in", () =>
      handles.prisma.session.updateMany({
        where: { userId: device.userId },
        data: { expiresAt: new Date(Date.now() - 1_000) },
      }),
    );
    expect(await revokedAt(device.deviceId)).toBeNull();

    const phone = await owner.signIn();
    const listed = await handles.app.request(USER_DEVICE_PATH, { headers: { cookie: phone } });
    expect((await listed.json()).devices).toEqual([]);
    const released = await runAsSystem("read a paired computer", () =>
      handles.prisma.userDevice.findUniqueOrThrow({ where: { id: device.deviceId } }),
    );
    expect(released).toMatchObject({ revokedBy: "session" });
    expect(released.revokedAt).toBeInstanceOf(Date);
  });

  it("tells a computer reconnecting after its sign-in ended why it was turned away", async () => {
    const owner = await newAccount();
    const desktop = await owner.signIn();
    const signedOut = await pair(desktop);
    const removed = await pair(await owner.signIn());
    await auth("/sign-out", {}, desktop);
    await handles.app.request(`${USER_DEVICE_PATH}/${removed.deviceId}`, {
      method: "DELETE",
      headers: { cookie: await owner.signIn() },
    });

    const reasons = await runAsSystem("read revoke reasons", () =>
      handles.prisma.userDevice.findMany({
        where: { id: { in: [signedOut.deviceId, removed.deviceId] } },
        select: { id: true, revokedBy: true },
      }),
    );
    expect(Object.fromEntries(reasons.map((row) => [row.id, row.revokedBy]))).toEqual({
      [signedOut.deviceId]: "session",
      [removed.deviceId]: "owner",
    });
  });
});
