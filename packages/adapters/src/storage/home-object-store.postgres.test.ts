import { randomBytes, randomUUID } from "node:crypto";
import type { PrismaClient, SpaceKeyRecord, SpaceKeyStore } from "@rakazo/db";
import {
  asSystem,
  ContentKeyRing,
  createDb,
  LocalKeyProvider,
  provisionMessagingIdentity,
  runAsSystem,
} from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaAgentHomeRecords } from "./home-object-store.js";
import { HomeRestoreRunningError, HomeVersionNotFoundError } from "./home-versions.js";

const url = process.env.DATABASE_URL;
const describePostgres = process.env.VERIFY_DATABASE === "1" && url ? describe : describe.skip;

describePostgres("agent home storage records (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let system: PrismaClient;
  let identity: { userId: string; spaceId: string };
  const address = `home-records-${randomUUID()}@rakazo.test`;

  beforeAll(async () => {
    db = createDb(url!);
    system = asSystem(db.prisma);
    identity = await runAsSystem("home storage records fixture", () =>
      provisionMessagingIdentity(db.prisma, { provider: "email", address }),
    );
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

  it("records a save without moving the stamp an idle suspension claimed", async () => {
    const homeKey = `home-records-${randomUUID()}`;
    const computer = await system.computer.create({
      data: {
        spaceId: identity.spaceId,
        userId: identity.userId,
        scopeKey: homeKey,
        homeKey,
        kind: "fake",
        state: "running",
      },
    });
    const claimedAt = new Date(computer.updatedAt.getTime() + 1_000);
    await system.computer.update({
      where: { id: computer.id },
      data: { state: "suspending", updatedAt: claimedAt },
    });
    const records = new PrismaAgentHomeRecords(db.prisma, memoryRing());

    const stored = await records.create(homeKey);
    expect(stored?.revision).toBeNull();
    expect(await records.advance(homeKey, stored!.storageId, null, "rev-1")).toBe(true);
    expect(await records.advance(homeKey, stored!.storageId, null, "rev-2")).toBe(false);

    const finished = await system.computer.updateMany({
      where: { id: computer.id, state: "suspending", updatedAt: claimedAt },
      data: { state: "suspended" },
    });
    expect(finished.count).toBe(1);
    expect((await records.load(homeKey))?.revision).toBe("rev-1");
  });

  it("leaves the revision where it was when its version cannot be recorded", async () => {
    const homeKey = `home-versions-${randomUUID()}`;
    await system.computer.create({
      data: {
        spaceId: identity.spaceId,
        userId: identity.userId,
        scopeKey: homeKey,
        homeKey,
        kind: "fake",
        state: "running",
      },
    });
    const records = new PrismaAgentHomeRecords(db.prisma, memoryRing());
    const { storageId } = (await records.create(homeKey))!;
    expect(await records.advance(homeKey, storageId, null, "rev-1")).toBe(true);
    const failing = new PrismaAgentHomeRecords(
      {
        computer: db.prisma.computer,
        computerHomeVersion: db.prisma.computerHomeVersion,
        $transaction: ((work: (tx: PrismaClient) => Promise<unknown>) =>
          db.prisma.$transaction((tx) =>
            work({
              computer: tx.computer,
              computerHomeVersion: {
                createMany: () => Promise.reject(new Error("connection lost")),
              },
            } as unknown as PrismaClient),
          )) as unknown as PrismaClient["$transaction"],
      },
      memoryRing(),
    );

    await expect(failing.advance(homeKey, storageId, "rev-1", "rev-2")).rejects.toThrow(
      "connection lost",
    );
    expect((await records.load(homeKey))?.revision).toBe("rev-1");
    expect(await records.advance(homeKey, storageId, "rev-1", "rev-2")).toBe(true);
    expect((await records.versions(homeKey))?.versions.map((v) => v.revision).sort()).toEqual([
      "rev-1",
      "rev-2",
    ]);
  });

  it("keeps versions across saves, prunes them and restores one", async () => {
    const homeKey = `home-versions-${randomUUID()}`;
    const computer = await system.computer.create({
      data: {
        spaceId: identity.spaceId,
        userId: identity.userId,
        scopeKey: homeKey,
        homeKey,
        kind: "fake",
        state: "running",
        providerRef: "machine-1",
      },
    });
    const records = new PrismaAgentHomeRecords(db.prisma, memoryRing());
    const { storageId } = (await records.create(homeKey))!;
    const revisions = ["rev-1", "rev-2", "rev-3", "rev-4", "rev-5"];
    let from: string | null = null;
    for (const revision of revisions) {
      expect(await records.advance(homeKey, storageId, from, revision)).toBe(true);
      from = revision;
    }
    const savedAt = (revision: string) =>
      new Date(Date.UTC(2026, 10, 19, 10) + revisions.indexOf(revision) * 60_000);
    for (const revision of revisions)
      await system.computerHomeVersion.updateMany({
        where: { storageId, revision },
        data: { savedAt: savedAt(revision) },
      });

    // The day's first save and the newest two stay.
    expect((await records.prune(homeKey, storageId, savedAt("rev-5"))).sort()).toEqual([
      "rev-2",
      "rev-3",
    ]);
    expect((await records.versions(homeKey))?.versions.map((v) => v.revision)).toEqual([
      "rev-5",
      "rev-4",
      "rev-1",
    ]);
    expect((await records.revisions([storageId])).get(storageId)).toEqual(
      new Set(["rev-1", "rev-4", "rev-5"]),
    );

    await expect(records.restore(homeKey, storageId, "rev-1")).rejects.toThrow(
      HomeRestoreRunningError,
    );
    await system.computer.update({ where: { id: computer.id }, data: { state: "suspended" } });
    await expect(records.restore(homeKey, storageId, "rev-2")).rejects.toThrow(
      HomeVersionNotFoundError,
    );
    await records.restore(homeKey, storageId, "rev-1");
    expect(
      await system.computer.findUniqueOrThrow({
        where: { id: computer.id },
        select: { homeStorageRevision: true, homeRevision: true, restorePending: true },
      }),
    ).toEqual({ homeStorageRevision: "rev-1", homeRevision: "rev-1", restorePending: true });
    // A prune right after never drops the restored revision, however old it is.
    expect(await records.prune(homeKey, storageId, savedAt("rev-5"))).toEqual([]);

    await system.computer.delete({ where: { id: computer.id } });
    expect(await system.computerHomeVersion.count({ where: { storageId } })).toBe(0);
  });
});

function memoryRing() {
  const keys: SpaceKeyRecord[] = [];
  const store: SpaceKeyStore = {
    forSpace: async (spaceId) => keys.filter((row) => row.spaceId === spaceId),
    byId: async (id) => keys.find((row) => row.id === id),
    insert: async (record) => {
      keys.push(record);
      return record;
    },
    rowContext: async () => undefined,
    sampleByMasterKey: async () => [],
  };
  return new ContentKeyRing(new LocalKeyProvider([{ id: "k1", key: randomBytes(32) }]), store);
}
