import { createHmac, randomUUID } from "node:crypto";
import { createAuth } from "@rakazo/auth";
import type { AccountSessions } from "@rakazo/contracts";
import { createDb, runAsSystem } from "@rakazo/db";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mountAccountIdentityGuard, mountAccountSessions } from "./account-sessions.js";

const suite =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe.sequential : describe.skip;
suite("saved account sessions and notifications (PostgreSQL)", () => {
  const stamp = randomUUID();
  const ids = { family: `family-${stamp}`, work: `work-${stamp}` };
  const origin = "http://web.example.test";
  const base = "http://api.example.test";
  const secret = "offline-account-session-secret-at-least-32-characters";
  const revoked = vi.fn();
  let db: ReturnType<typeof createDb>;
  let auth: ReturnType<typeof createAuth>;
  let app: Hono;
  let cookieName: string;
  const tokens = { family: `family-token-${stamp}`, work: `work-token-${stamp}` };
  const sign = (token: string) =>
    `${token}.${createHmac("sha256", secret).update(token).digest("base64")}`;
  const cookie = (active: keyof typeof ids = "work") =>
    [
      `${cookieName}=${encodeURIComponent(sign(tokens[active]))}`,
      ...Object.values(tokens).map(
        (token) => `${cookieName}_multi-${token.toLowerCase()}=${encodeURIComponent(sign(token))}`,
      ),
    ].join("; ");
  const request = (path: string, init?: RequestInit) => app.request(`${base}${path}`, init);

  beforeAll(async () => {
    db = createDb(process.env.DATABASE_URL!);
    await runAsSystem("seed saved account fixtures", async () => {
      for (const key of ["family", "work"] as const) {
        const userId = ids[key];
        const organizationId = `org-${userId}`;
        const spaceId = `space-${userId}`;
        await db.prisma.user.create({
          data: {
            id: userId,
            email: `${key}-${stamp}@example.test`,
            name: key,
            emailVerified: true,
          },
        });
        await db.prisma.organization.create({
          data: {
            id: organizationId,
            name: "Fixture",
            slug: organizationId,
            createdAt: new Date(),
          },
        });
        await db.prisma.space.create({
          data: { id: spaceId, organizationId, name: "Fixture", isDefault: true },
        });
        await db.prisma.member.create({
          data: {
            id: `member-${userId}`,
            userId,
            organizationId,
            role: "owner",
            createdAt: new Date(),
          },
        });
        await db.prisma.session.create({
          data: {
            id: `session-${userId}`,
            userId,
            token: tokens[key],
            expiresAt: new Date(Date.now() + 3600_000),
          },
        });
        for (const [index, enabled] of [true, false].entries()) {
          if (key === "work" && !enabled) continue;
          const botId = `bot-${userId}-${index}`;
          const threadId = `thread-${userId}-${index}`;
          await db.prisma.bot.create({
            data: {
              id: botId,
              userId,
              spaceId,
              name: `Fixture ${index}`,
              color: "blue",
              notifyOnFinish: enabled,
            },
          });
          await db.prisma.thread.create({
            data: { id: threadId, botId, userId, spaceId, unread: true },
          });
          await db.prisma.event.create({
            data: {
              id: `event-${userId}-${index}`,
              threadId,
              botId,
              spaceId,
              seq: 0,
              type: "thread.message.created",
              payload: { role: "bot", blocks: [{ kind: "text", text: `Private ${key} reply` }] },
            },
          });
        }
      }
    });
    auth = createAuth(db.prisma, {
      secret,
      baseURL: base,
      webOrigin: origin,
      signupsEnabled: "true",
      signupAllowlist: "",
      afterDeleteSession: async (session) => {
        revoked(session);
      },
    });
    cookieName = (await auth.$context).authCookies.sessionToken.name;
    app = new Hono();
    mountAccountIdentityGuard(app, (req) =>
      runAsSystem(
        "authenticate fixture guard",
        async () => (await auth.api.getSession({ headers: req.headers }))?.user.id ?? null,
      ),
    );
    app.on(["GET", "POST"], "/api/auth/*", (c) =>
      runAsSystem("fixture authentication", () => auth.handler(c.req.raw)),
    );
    mountAccountSessions(app, {
      auth,
      prisma: db.prisma,
      trustedOrigin: (value) => value === origin,
    });
    app.post("/private", (c) => c.json({ userId: ids.work }));
  });
  afterAll(async () => {
    if (!db) return;
    await runAsSystem("remove saved account fixtures", async () => {
      await db.prisma.organization.deleteMany({
        where: { id: { in: Object.values(ids).map((id) => `org-${id}`) } },
      });
      await db.prisma.user.deleteMany({ where: { id: { in: Object.values(ids) } } });
    });
    await db.pool.end();
  });

  it("reads both accounts without changing selection and respects each notification preference", async () => {
    const response = await request("/api/accounts", { headers: { cookie: cookie() } });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const text = await response.text();
    const body = JSON.parse(text) as AccountSessions;
    expect(body.activeUserId).toBe(ids.work);
    expect(body.accounts.map((account) => account.userId).sort()).toEqual(
      Object.values(ids).sort(),
    );
    const family = body.accounts.find((account) => account.userId === ids.family)!;
    expect(family.unread).toBe(2);
    expect(family.notifications).toEqual([
      expect.objectContaining({
        id: `event-${ids.family}-0`,
        body: "Private family reply",
        spaceId: `space-${ids.family}`,
      }),
    ]);
    expect(body.accounts.find((account) => account.userId === ids.work)?.unread).toBe(1);
    for (const token of Object.values(tokens)) expect(text).not.toContain(token);
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("keeps internal background failures out of account notifications", async () => {
    const userId = ids.family;
    const data = {
      userId,
      spaceId: `space-${userId}`,
      botId: `bot-${userId}-0`,
      threadId: `thread-${userId}-0`,
    };
    await runAsSystem("seed an internal background failure", async () => {
      const task = await db.prisma.task.create({
        data: { ...data, prompt: "Fixture", status: "failed" },
      });
      const run = await db.prisma.run.create({
        data: { ...data, taskId: task.id, trigger: "tickets", status: "failed" },
      });
      await db.prisma.event.create({
        data: {
          spaceId: data.spaceId,
          botId: data.botId,
          threadId: data.threadId,
          id: `background-${stamp}`,
          runId: run.id,
          type: "run.failed",
          seq: 1,
          payload: {},
        },
      });
    });
    const body = (await (
      await request("/api/accounts", { headers: { cookie: cookie() } })
    ).json()) as AccountSessions;
    const notifications = body.accounts.find((account) => account.userId === userId)!.notifications;
    expect(notifications.some((item) => item.id === `event-${userId}-0`)).toBe(true);
    expect(notifications.some((item) => item.id === `background-${stamp}`)).toBe(false);
  });

  it("returns only the native bearer identity even when the HTTP host also sends cookies", async () => {
    const response = await request("/api/accounts", {
      headers: { authorization: `Bearer ${sign(tokens.family)}`, cookie: cookie() },
    });
    const body = (await response.json()) as AccountSessions;
    expect(body.activeUserId).toBe(ids.family);
    expect(body.accounts.map((account) => account.userId)).toEqual([ids.family]);
    const invalid = await request("/api/accounts", {
      headers: { authorization: "Bearer invalid", cookie: cookie() },
    });
    expect(await invalid.json()).toEqual({ activeUserId: null, accounts: [] });
  });

  it("pages past filtered events and gives attention notices a readable body", async () => {
    const userId = ids.family;
    const spaceId = `space-${userId}`;
    const botId = `bot-${userId}-0`;
    const threadId = `thread-${userId}-0`;
    const older = new Date(Date.now() - 60_000);
    const events = [
      ...Array.from({ length: 110 }, (_, index) => ({
        id: `filtered-${stamp}-${index}`,
        spaceId,
        botId,
        threadId,
        seq: 100 + index,
        type: "thread.message.created",
        payload: { role: "user", blocks: [{ kind: "text", text: "Fixture" }] },
        createdAt: new Date(),
      })),
      ...["run.failed", "run.waiting_input", "computer.takeover.requested"].map((type, index) => ({
        id: `attention-${stamp}-${index}`,
        spaceId,
        botId,
        threadId,
        seq: 300 + index,
        type,
        payload:
          index === 0
            ? { error: "Fixture failure" }
            : index === 2
              ? { reason: "Fixture needs a click" }
              : {},
        createdAt: older,
      })),
    ];
    await runAsSystem("seed paginated account notification fixtures", () =>
      db.prisma.event.createMany({ data: events }),
    );
    try {
      const body = (await (
        await request("/api/accounts", { headers: { cookie: cookie() } })
      ).json()) as AccountSessions;
      const notices = body.accounts.find((account) => account.userId === userId)!.notifications;
      for (let index = 0; index < 3; index++)
        expect(
          notices.find((notice) => notice.id === `attention-${stamp}-${index}`)?.body,
        ).toBeTruthy();
      expect(notices.find((notice) => notice.id === `attention-${stamp}-0`)?.body).toBe(
        "Fixture failure",
      );
      expect(notices.find((notice) => notice.id === `attention-${stamp}-2`)?.body).toBe(
        "Fixture needs a click",
      );
      expect(notices.some((notice) => notice.id.startsWith(`filtered-${stamp}-`))).toBe(false);
    } finally {
      await runAsSystem("remove paginated account notification fixtures", () =>
        db.prisma.event.deleteMany({ where: { id: { in: events.map((event) => event.id) } } }),
      );
    }
  });

  it("rejects a stale page's mutation before the handler uses its body under a different account", async () => {
    const stale = await request("/private", {
      method: "POST",
      headers: { cookie: cookie(), "x-rakazo-user-id": ids.family },
    });
    expect(stale.status).toBe(401);
    const current = await request("/private", {
      method: "POST",
      headers: { cookie: cookie(), "x-rakazo-user-id": ids.work },
    });
    expect(current.status).toBe(200);
  });

  it("rejects unproven or untrusted selections, then removes only the selected account session", async () => {
    const select = (userId: string, requestOrigin = origin) =>
      request("/api/accounts/select", {
        method: "POST",
        headers: { cookie: cookie(), origin: requestOrigin, "content-type": "application/json" },
        body: JSON.stringify({ userId }),
      });
    expect((await select("unproven-user")).status).toBe(401);
    expect((await select(ids.family, "https://evil.example.test")).status).toBe(403);
    const selected = await select(ids.family);
    expect(selected.status).toBe(200);
    expect(await selected.json()).toEqual({ userId: ids.family });
    expect(selected.headers.get("set-cookie")).toContain(cookieName);
    const removed = await request("/api/accounts/remove", {
      method: "POST",
      headers: { cookie: cookie("family"), origin, "content-type": "application/json" },
      body: JSON.stringify({ userId: ids.family }),
    });
    expect(removed.status).toBe(200);
    expect(revoked).toHaveBeenCalledWith(expect.objectContaining({ userId: ids.family }));
    const body = (await (
      await request("/api/accounts", { headers: { cookie: cookie() } })
    ).json()) as AccountSessions;
    expect(body.accounts.map((account) => account.userId)).toEqual([ids.work]);
    expect((await select(ids.family)).status).toBe(401);
    await runAsSystem("expire fixture session", () =>
      db.prisma.session.update({
        where: { id: `session-${ids.work}` },
        data: { expiresAt: new Date(0) },
      }),
    );
    expect((await select(ids.work)).status).toBe(401);
  });
});
