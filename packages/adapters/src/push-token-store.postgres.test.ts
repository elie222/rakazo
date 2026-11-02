import { randomUUID } from "node:crypto";
import { createDb, runAsSystem, runAsTenant } from "@rakazo/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { credentialDigest } from "./credential-digest.js";
import { PrismaPushTokenStore, PushSessionEndedError } from "./push-token-store.js";

const suite =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe.sequential : describe.skip;
suite("database push registrations", () => {
  let a: ReturnType<typeof createDb>;
  let b: ReturnType<typeof createDb>;
  let api: PrismaPushTokenStore;
  let worker: PrismaPushTokenStore;
  const prefix = `push-fixture-${randomUUID()}`;
  const user = (id: string) => `${prefix}-${id}`;
  const session = (id: string) => `${prefix}-session-${id}`;
  const token = (id: string) => `ExponentPushToken[${prefix}-${id}]`;
  beforeAll(async () => {
    a = createDb(process.env.DATABASE_URL!);
    b = createDb(process.env.DATABASE_URL!);
    api = new PrismaPushTokenStore(a.prisma, "offline-push-encryption-key");
    worker = new PrismaPushTokenStore(b.prisma, "offline-push-encryption-key");
    await runAsSystem("seed push registration fixtures", async () => {
      for (const id of ["a", "b", "c"]) {
        await a.prisma.user.create({
          data: { id: user(id), name: "Fixture", email: `${user(id)}@example.invalid` },
        });
        await a.prisma.session.create({
          data: {
            id: session(id),
            token: session(id),
            userId: user(id),
            expiresAt: new Date(Date.now() + 3600_000),
          },
        });
      }
      await a.prisma.session.create({
        data: {
          id: session("a2"),
          token: session("a2"),
          userId: user("a"),
          expiresAt: new Date(Date.now() + 3600_000),
        },
      });
    });
  });
  beforeEach(async () => {
    await runAsSystem("clear fixture push registrations", async () => {
      await a.prisma.pushToken.deleteMany({ where: { userId: { startsWith: prefix } } });
      await a.prisma.pushRegistration.deleteMany({ where: { userId: { startsWith: prefix } } });
    });
  });
  afterAll(async () => {
    if (!a) return;
    await runAsSystem("remove push registration fixtures", () =>
      a.prisma.user.deleteMany({ where: { id: { startsWith: prefix } } }),
    );
    await Promise.all([a.pool.end(), b.pool.end()]);
  });

  it("shares encrypted registrations across independent connections and restricts row access", async () => {
    await api.save(user("a"), token("a"), session("a"));
    expect(await worker.load(user("a"))).toEqual({ token: token("a"), sessionId: session("a") });
    const row = await runAsSystem("inspect fixture ciphertext", () =>
      a.prisma.pushRegistration.findUniqueOrThrow({
        where: { userId_sessionId: { userId: user("a"), sessionId: session("a") } },
      }),
    );
    expect(row.ciphertext).not.toContain(token("a"));
    expect(row.tokenDigest).toBe(credentialDigest(token("a")));
    await runAsTenant({ userId: user("b"), spaceId: "unused" }, async () => {
      expect(await a.prisma.pushToken.findMany()).toEqual([]);
      expect(await a.prisma.pushRegistration.findMany()).toEqual([]);
    });
  });

  it("retains every account when the same device registers concurrently", async () => {
    await Promise.all([
      api.save(user("a"), token("shared"), session("a")),
      worker.save(user("b"), token("shared"), session("b")),
      api.save(user("c"), token("shared"), session("c")),
    ]);
    const registrations = await Promise.all([
      api.load(user("a")),
      worker.load(user("b")),
      api.load(user("c")),
    ]);
    expect(registrations.filter(Boolean)).toHaveLength(3);
  });

  it("preserves the previous release's single-account device without evicting another account", async () => {
    await api.save(user("a"), token("shared"), session("a"));
    await worker.save(user("b"), token("shared"), session("b"));
    const legacy = await runAsSystem("read previous-release push registration", () =>
      a.prisma.pushToken.findUnique({ where: { userId: user("a") } }),
    );
    expect(legacy?.tokenDigest).toBe(credentialDigest(token("shared")));
    expect(legacy?.sessionId).toBe(session("a"));
    expect((await worker.list(user("b")))[0]?.token).toBe(token("shared"));
  });

  it("keeps newer registrations when an old receipt or logout arrives", async () => {
    await api.save(user("a"), token("a"), session("a"));
    await worker.save(user("a"), token("new"), session("a2"));
    await api.remove(user("a"), credentialDigest(token("a")));
    await api.endSession(user("a"), session("a"));
    expect((await worker.load(user("a")))?.token).toBe(token("new"));
    await api.remove(user("a"), credentialDigest(token("new")));
    expect(await worker.load(user("a"))).toBeUndefined();
  });

  it("retargets only the replaced session while another account retains the same device", async () => {
    await api.save(user("a"), token("shared"), session("a"));
    await worker.endSession(user("a"), session("a"), session("a2"));
    await api.endSession(user("a"), session("a"));
    expect((await worker.load(user("a")))?.sessionId).toBe(session("a2"));
    await worker.save(user("b"), token("shared"), session("b"));
    await api.endSession(user("a"), session("a2"), session("a"));
    expect((await api.load(user("a")))?.sessionId).toBe(session("a"));
    expect((await worker.load(user("b")))?.token).toBe(token("shared"));
  });

  it("imports only unclaimed devices and accounts, including concurrent imports", async () => {
    await api.save(user("b"), token("owned"), session("b"));
    expect(await worker.importLegacy(user("a"), token("owned"), session("a"))).toBe(false);
    expect(await worker.load(user("a"))).toBeUndefined();
    expect((await api.load(user("b")))?.token).toBe(token("owned"));
    expect(await worker.importLegacy(user("b"), token("stale"), session("b"))).toBe(false);
    expect((await api.load(user("b")))?.token).toBe(token("owned"));
    const imported = await Promise.all([
      api.importLegacy(user("a"), token("unclaimed"), session("a")),
      worker.importLegacy(user("c"), token("unclaimed"), session("c")),
    ]);
    expect(imported.filter(Boolean)).toHaveLength(1);
  });

  it("retains authenticated registration during a concurrent legacy import", async () => {
    await Promise.all([
      api.importLegacy(user("a"), token("racing"), session("a")),
      worker.save(user("b"), token("racing"), session("b")),
    ]);
    expect((await worker.load(user("b")))?.token).toBe(token("racing"));
  });

  it("keeps multiple devices and removes only the signed-out login", async () => {
    await api.save(user("a"), token("phone"), session("a"));
    await api.save(user("a"), token("tablet"), session("a2"));
    expect((await worker.list(user("a"))).map((row) => row.token).sort()).toEqual(
      [token("phone"), token("tablet")].sort(),
    );
    await api.endSession(user("a"), session("a"));
    expect(await worker.list(user("a"))).toEqual([
      { token: token("tablet"), sessionId: session("a2") },
    ]);
  });

  it("reads old-release registrations and removes their fallback on unregister", async () => {
    await api.save(user("a"), token("legacy"), session("a"));
    await runAsSystem("seed old-release push row", async () => {
      const row = await a.prisma.pushRegistration.findFirstOrThrow({
        where: { userId: user("a") },
      });
      await a.prisma.pushToken.upsert({ where: { userId: user("a") }, create: row, update: row });
      await a.prisma.pushRegistration.deleteMany({ where: { userId: user("a") } });
    });
    expect((await worker.list(user("a")))[0]?.token).toBe(token("legacy"));
    await api.endSession(user("a"), session("a"));
    expect(await worker.list(user("a"))).toEqual([]);
  });

  it("aggregates the device badge across live accounts and ignores other devices", async () => {
    const organizations: string[] = [];
    try {
      await runAsSystem("seed unread device badge fixtures", async () => {
        for (const id of ["a", "b", "c"]) {
          const organizationId = `${prefix}-badge-${id}`;
          organizations.push(organizationId);
          await a.prisma.organization.create({
            data: {
              id: organizationId,
              name: "Fixture",
              slug: organizationId,
              createdAt: new Date(),
            },
          });
          await a.prisma.member.create({
            data: {
              id: randomUUID(),
              organizationId,
              userId: user(id),
              role: "member",
              createdAt: new Date(),
            },
          });
          const space = await a.prisma.space.create({
            data: { id: randomUUID(), organizationId, name: "Fixture" },
          });
          await a.prisma.spaceMember.create({
            data: {
              id: randomUUID(),
              organizationId,
              spaceId: space.id,
              userId: user(id),
              createdAt: new Date(),
            },
          });
          await a.prisma.bot.create({
            data: {
              spaceId: space.id,
              userId: user(id),
              name: "Fixture",
              color: "blue",
              thread: { create: { spaceId: space.id, userId: user(id), unread: true } },
            },
          });
        }
      });
      await api.save(user("a"), token("shared"), session("a"));
      await api.save(user("b"), token("shared"), session("b"));
      await api.save(user("c"), token("other-device"), session("c"));
      expect(await worker.deviceForToken(token("shared"))).toEqual({ badge: 2, accounts: 2 });
      await api.endSession(user("b"), session("b"));
      expect(await worker.deviceForToken(token("shared"))).toEqual({ badge: 1, accounts: 1 });
    } finally {
      await runAsSystem("remove unread device badge fixtures", () =>
        a.prisma.organization.deleteMany({ where: { id: { in: organizations } } }),
      );
    }
  });

  it("rejects expired, missing and another account's sessions without stealing tokens", async () => {
    await api.save(user("a"), token("shared"), session("a"));
    for (const invalid of [session("missing"), session("a")])
      await expect(worker.save(user("b"), token("shared"), invalid)).rejects.toBeInstanceOf(
        PushSessionEndedError,
      );
    await runAsSystem("expire fixture session", () =>
      a.prisma.session.update({ where: { id: session("c") }, data: { expiresAt: new Date(0) } }),
    );
    await expect(worker.save(user("c"), token("shared"), session("c"))).rejects.toBeInstanceOf(
      PushSessionEndedError,
    );
    expect((await api.load(user("a")))?.token).toBe(token("shared"));
  });

  it("does not publish a registration after a concurrent session deletion commits", async () => {
    let release!: () => void;
    let locked!: () => void;
    const ready = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const deletion = runAsSystem("delete fixture session concurrently", () =>
      a.prisma.$transaction(async (tx) => {
        await tx.session.delete({ where: { id: session("a2") } });
        locked();
        await hold;
      }),
    );
    await ready;
    const registering = worker.save(user("a"), token("late"), session("a2"));
    // Attach rejection handling before releasing the blocked registration.
    const rejected = expect(registering).rejects.toBeInstanceOf(PushSessionEndedError);
    release();
    await deletion;
    await rejected;
    expect(await api.load(user("a"))).toBeUndefined();
  });
});
