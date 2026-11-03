import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AdapterContext } from "@rakazo/adapter-kit";
import { EmailEmulator, ObjectAgentHomeStore, PrismaAgentHomeRecords } from "@rakazo/adapters";
import type { PrismaClient, SpaceKeyRecord, SpaceKeyStore } from "@rakazo/db";
import { asSystem, ContentKeyRing, createDb, LocalKeyProvider } from "@rakazo/db";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryObjectStorage } from "../../../packages/adapters/src/object-storage.test-support.js";
import { homeRetentionSweep } from "./home-retention.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;
const DAY = 24 * 60 * 60 * 1000;

describePostgres("saved home retention (PostgreSQL)", () => {
  let prisma: PrismaClient;
  let system: PrismaClient;
  let close: () => Promise<void>;
  let root: string;
  let storage: MemoryObjectStorage;
  let home: ObjectAgentHomeStore;
  let email: EmailEmulator;
  let errors: unknown[];
  let id: string;
  let now: number;
  const context: AdapterContext = {
    operationId: "test",
    traceId: "test",
    spaceId: "test",
    userId: "test",
    signal: new AbortController().signal,
  };
  const sweep = () =>
    homeRetentionSweep({
      prisma,
      home,
      email,
      appUrl: "https://app.example.test/app",
      onError: (error) => errors.push(error),
    })();
  const travel = (days: number) => {
    now += days * DAY;
    vi.setSystemTime(now);
  };
  const computer = () => system.computer.findUniqueOrThrow({ where: { id } });
  const objects = () => [...storage.objects.keys()];
  const sent = () => email.sent.filter((message) => message.to === `${id}@rakazo.test`);

  beforeAll(async () => {
    const db = createDb(databaseUrl!);
    prisma = db.prisma;
    system = asSystem(prisma);
    close = async () => {
      await db.prisma.$disconnect();
      await db.pool.end();
    };
  });

  afterAll(async () => {
    await close?.();
  });

  beforeEach(async () => {
    now = Date.now();
    vi.useFakeTimers({ toFake: ["Date"], now });
    id = `retention-${randomBytes(6).toString("hex")}`;
    root = await mkdtemp(path.join(tmpdir(), "rakazo-retention-"));
    storage = new MemoryObjectStorage();
    home = new ObjectAgentHomeStore(root, storage, new PrismaAgentHomeRecords(system, ring()));
    email = new EmailEmulator();
    errors = [];
    await system.user.create({
      data: { id, name: "Alex", email: `${id}@rakazo.test`, emailVerified: true },
    });
    await system.organization.create({ data: { id, name: id, slug: id, createdAt: new Date() } });
    await system.space.create({ data: { id, organizationId: id, name: "Mine", isDefault: true } });
    await system.computer.create({
      data: {
        id,
        spaceId: id,
        userId: id,
        scopeKey: id,
        homeKey: id,
        kind: "fake",
        providerRef: `sandbox-${id}`,
        state: "stopped",
        createdAt: new Date(now - 100 * DAY),
      },
    });
    const files = await mkdtemp(path.join(tmpdir(), "rakazo-retention-files-"));
    await writeFile(path.join(files, "notes.md"), "keep me");
    await home.commit(id, files, context);
    await system.computer.update({
      where: { id },
      data: { homeRevision: "rev-1", homeRevisionAt: new Date(now - 100 * DAY) },
    });
  });

  afterEach(async () => {
    vi.useRealTimers();
    await system.organization.deleteMany({ where: { id } });
    await system.user.deleteMany({ where: { id } });
    await rm(root, { recursive: true, force: true });
  });

  it("warns once, then deletes only the stored copy of an unused computer", async () => {
    await sweep();
    await sweep();
    expect(sent()).toHaveLength(1);
    expect(sent()[0]!.text).toContain("unless you use your bots before then");
    expect(objects()).toHaveLength(1);

    travel(6);
    await sweep();
    expect(objects()).toHaveLength(1);

    travel(2);
    await sweep();
    expect(errors).toEqual([]);
    expect(objects()).toEqual([]);
    expect(await computer()).toMatchObject({
      providerRef: `sandbox-${id}`,
      homeStorageId: null,
      homeStorageRevision: null,
      homeRevision: "empty",
      homeRevisionAt: null,
    });
    expect(await system.homeDeletionNotice.count({ where: { computerId: id } })).toBe(0);
    expect(sent()).toHaveLength(1);
  });

  it("gives a cancelled plan 30 days and keeps the files once it resubscribes", async () => {
    await system.billingAccount.create({
      data: {
        organizationId: id,
        customerId: `cus-${id}`,
        status: "active",
        subscribedAt: new Date(now - 200 * DAY),
      },
    });
    await sweep();
    expect(sent()).toHaveLength(0);

    await system.billingAccount.update({
      where: { organizationId: id },
      data: { status: "canceled", endedAt: new Date(now - 25 * DAY) },
    });
    await sweep();
    expect(sent()).toHaveLength(1);
    expect(sent()[0]!.text).toContain("unless you resubscribe");

    await system.billingAccount.update({
      where: { organizationId: id },
      data: { status: "active", endedAt: null },
    });
    travel(8);
    await sweep();
    expect(objects()).toHaveLength(1);
    expect(await system.homeDeletionNotice.count({ where: { computerId: id } })).toBe(0);
  });

  it("keeps the files when the computer is used after the warning", async () => {
    await sweep();
    expect(sent()).toHaveLength(1);
    travel(3);
    await system.computerRun.create({
      data: { computerId: id, kind: "fake", startedAt: new Date(now), endedAt: new Date(now) },
    });
    travel(5);
    await sweep();
    expect(objects()).toHaveLength(1);
    expect(sent()).toHaveLength(1);
  });

  it("never deletes without a delivered warning", async () => {
    email.failNextSends(1);
    await sweep();
    expect(errors).toHaveLength(1);
    travel(8);
    await sweep();
    expect(objects()).toHaveLength(1);
    expect(sent()).toHaveLength(1);
  });

  it("waits for a running computer to stop", async () => {
    await sweep();
    await system.computer.update({ where: { id }, data: { state: "running" } });
    travel(8);
    await sweep();
    expect(objects()).toHaveLength(1);
    await system.computer.update({ where: { id }, data: { state: "suspended" } });
    await sweep();
    expect(objects()).toEqual([]);
  });

  it("finishes a deletion interrupted after the computer was cleared", async () => {
    await sweep();
    travel(8);
    const remove = vi.spyOn(storage, "delete").mockRejectedValueOnce(new Error("bucket down"));
    await sweep();
    remove.mockRestore();
    expect(errors).toHaveLength(1);
    expect((await computer()).homeStorageId).toBeNull();

    travel(1);
    await sweep();
    expect(await system.homeDeletionNotice.count({ where: { computerId: id } })).toBe(0);
    expect(objects()).toEqual([]);
  });
});

function ring() {
  const keys: SpaceKeyRecord[] = [];
  const store: SpaceKeyStore = {
    forSpace: async (spaceId) => keys.filter((row) => row.spaceId === spaceId),
    byId: async (keyId) => keys.find((row) => row.id === keyId),
    insert: async (record) => {
      keys.push(record);
      return record;
    },
    rowContext: async () => undefined,
    sampleByMasterKey: async () => [],
  };
  return new ContentKeyRing(new LocalKeyProvider([{ id: "k1", key: randomBytes(32) }]), store);
}
