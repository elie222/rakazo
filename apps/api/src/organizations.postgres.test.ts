import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRouterClient } from "@orpc/server";
import type {
  ArtifactStore,
  ComputerRef,
  JobPublisher,
  SandboxProvider,
} from "@rakazo/adapter-kit";
import { BillingEmulator, ObjectAgentHomeStore, PrismaAgentHomeRecords } from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient, SpaceKeyRecord, SpaceKeyStore } from "@rakazo/db";
import {
  asSystem,
  billingAccountForOrganization,
  bootstrapUserSpace,
  ContentKeyRing,
  createDb,
  extendByokFreePeriod,
  IsolationError,
  installAuditEventStore,
  LocalKeyProvider,
  personalOrganizationIds,
  runAsSystem,
} from "@rakazo/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryObjectStorage } from "../../../packages/adapters/src/object-storage.test-support.js";
import { deleteAccountContent } from "./account-deletion.js";
import { createBillingService } from "./billing.js";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

describePostgres("organizations (PostgreSQL)", () => {
  const suffix = `${process.pid}-${Date.now()}-${randomBytes(3).toString("hex")}`;
  const users: string[] = [];
  let db: ReturnType<typeof createDb>;
  let prisma: PrismaClient;
  let system: PrismaClient;
  let root: string;
  let home: ObjectAgentHomeStore;
  let sandbox: ReturnType<typeof fakeSandbox>;
  let emulator: BillingEmulator;
  let billing: ReturnType<typeof createBillingService>;
  let sequence = 0;

  const deps = () =>
    ({
      prisma,
      env: {},
      sandbox: sandbox as unknown as SandboxProvider,
      home,
      jobs: { cancel: vi.fn(), enqueue: vi.fn() } as unknown as JobPublisher,
      artifacts: { remove: vi.fn() } as unknown as ArtifactStore,
      dataDir: root,
      billing,
    }) as unknown as RouterDeps;
  const client = (actor: Actor) => createRouterClient(createRouter(deps()), { context: { actor } });
  const asUser = (actor: Actor, spaceId: string): Actor => ({ ...actor, spaceId });

  async function signup(): Promise<Actor> {
    const userId = `orgs-${++sequence}-${suffix}`;
    users.push(userId);
    const email = `${userId}@rakazo.test`;
    await system.user.create({ data: { id: userId, name: userId, email, emailVerified: false } });
    const { spaceId } = await bootstrapUserSpace(
      system,
      { id: userId },
      {
        signupsEnabled: undefined,
        signupAllowlist: undefined,
      },
    );
    return { userId, spaceId, email, isDeploymentOwner: false };
  }

  async function subscribe(actor: Actor) {
    await runAsSystem("organizations test", () => billing.checkout(actor));
    const space = await system.space.findUniqueOrThrow({ where: { id: actor.spaceId } });
    const { customerId } = (await billingAccountForOrganization(system, space.organizationId))!;
    emulator.completeCheckout(customerId, "active");
    await billing.sync(customerId);
    return customerId;
  }

  async function botWithComputer(spaceId: string, userId: string, providerRef: string) {
    const computer = await system.computer.create({
      data: {
        spaceId,
        userId,
        scope: "dedicated",
        scopeKey: `bot:${providerRef}`,
        homeKey: `home-${providerRef}`,
        kind: "e2b",
        providerRef,
      },
    });
    return system.bot.create({
      data: { spaceId, userId, name: providerRef, color: "blue", computerId: computer.id },
    });
  }

  beforeAll(async () => {
    db = createDb(databaseUrl!);
    prisma = db.prisma;
    system = asSystem(prisma);
    installAuditEventStore(prisma);
    root = await mkdtemp(path.join(tmpdir(), "rakazo-organizations-"));
    home = new ObjectAgentHomeStore(
      root,
      new MemoryObjectStorage(),
      new PrismaAgentHomeRecords(system, memoryRing()),
    );
  });

  beforeEach(() => {
    sandbox = fakeSandbox();
    emulator = new BillingEmulator({ namespace: `orgs-${++sequence}-${suffix}` });
    billing = createBillingService({
      prisma: system,
      provider: emulator,
      webOrigin: "https://app.example.test",
    });
  });

  afterAll(async () => {
    if (!db) return;
    installAuditEventStore(undefined);
    await system.auditEvent.deleteMany({ where: { actorId: { in: users } } });
    await system.organization.deleteMany({
      where: { members: { some: { userId: { in: users } } } },
    });
    await system.user.deleteMany({ where: { id: { in: users } } });
    await rm(root, { recursive: true, force: true });
    await db.prisma.$disconnect();
    await db.pool.end();
  });

  it("creates a named organization with a same-named default Space and lists only the caller's", async () => {
    const ada = await signup();
    const grace = await signup();
    await client(grace).organizations.create({ name: "Not yours" });

    const work = await client(ada).organizations.create({ name: "  Work " });

    expect(work).toEqual({ id: work.id, name: "Work", defaultSpaceId: work.id });
    await expect(
      system.space.findUniqueOrThrow({ where: { id: work.id }, include: { memberships: true } }),
    ).resolves.toMatchObject({
      organizationId: work.id,
      name: "Work",
      isDefault: true,
      memberships: [{ userId: ada.userId, role: "owner" }],
    });
    await expect(
      system.memoryDocument.count({ where: { spaceId: work.id, path: "MEMORY.md" } }),
    ).resolves.toBe(1);
    await expect(client(ada).organizations.list()).resolves.toEqual({
      activeOrganizationId: ada.spaceId,
      organizations: [
        { id: ada.spaceId, name: "Personal", defaultSpaceId: ada.spaceId, spaceIds: [ada.spaceId] },
        { id: work.id, name: "Work", defaultSpaceId: work.id, spaceIds: [work.id] },
      ],
    });
    await expect(client(asUser(ada, work.id)).organizations.list()).resolves.toMatchObject({
      activeOrganizationId: work.id,
    });
    await expect(
      system.auditEvent.count({
        where: { organizationId: work.id, action: "organization.created" },
      }),
    ).resolves.toBe(1);

    // The Space list stays within the current organization.
    const side = await client(asUser(ada, work.id)).spaces.create({ name: "Side" });
    expect((await client(ada).spaces.list()).spaces.map((space) => space.id)).toEqual([
      ada.spaceId,
    ]);
    expect(
      (await client(asUser(ada, work.id)).spaces.list()).spaces.map((space) => space.id),
    ).toEqual([work.id, side.id]);

    // An organization whose default Space is being deleted is already gone from the list.
    await system.space.update({ where: { id: work.id }, data: { deletingAt: new Date() } });
    expect((await client(ada).organizations.list()).organizations.map((org) => org.id)).toEqual([
      ada.spaceId,
    ]);
  });

  it("caps organizations at ten per person, even when two creates race", async () => {
    const ada = await signup();
    for (let index = 2; index <= 9; index += 1)
      await client(ada).organizations.create({ name: `Org ${index}` });

    const results = await Promise.allSettled([
      client(ada).organizations.create({ name: "Tenth A" }),
      client(ada).organizations.create({ name: "Tenth B" }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({
      reason: { code: "BAD_REQUEST", message: "You can have up to 10 organizations." },
    });
    await expect(system.member.count({ where: { userId: ada.userId } })).resolves.toBe(10);
  });

  it("lets only the owner rename or delete an organization, and never their last one", async () => {
    const ada = await signup();
    const grace = await signup();
    const theirs = await client(grace).organizations.create({ name: "Theirs" });

    await expect(
      client(ada).organizations.rename({ organizationId: theirs.id, name: "Mine now" }),
    ).rejects.toBeInstanceOf(IsolationError);
    await expect(
      client(ada).organizations.remove({ organizationId: theirs.id }),
    ).rejects.toBeInstanceOf(IsolationError);
    await expect(
      client(ada).organizations.remove({ organizationId: ada.spaceId }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(await system.organization.findUnique({ where: { id: theirs.id } })).toMatchObject({
      name: "Theirs",
    });

    await expect(
      client(grace).organizations.rename({ organizationId: theirs.id, name: "Side" }),
    ).resolves.toEqual({ id: theirs.id, name: "Side" });
    expect(await system.organization.findUnique({ where: { id: theirs.id } })).toMatchObject({
      name: "Side",
    });
    expect(await system.space.findUnique({ where: { id: theirs.id } })).toMatchObject({
      name: "Theirs",
    });
  });

  it("cancels the organization's billing and deletes its content, leaving the other intact", async () => {
    const ada = await signup();
    const work = await client(ada).organizations.create({ name: "Work" });
    const inWork = asUser(ada, work.id);
    const side = await client(inWork).spaces.create({ name: "Side" });
    const customerId = await subscribe(inWork);
    await botWithComputer(work.id, ada.userId, `sb-work-${suffix}`);
    await botWithComputer(side.id, ada.userId, `sb-side-${suffix}`);
    const kept = await botWithComputer(ada.spaceId, ada.userId, `sb-personal-${suffix}`);

    await expect(client(inWork).organizations.remove({ organizationId: work.id })).resolves.toEqual(
      { ok: true, activeSpaceId: ada.spaceId },
    );

    expect(emulator.subscriptions.filter((sub) => sub.customerId === customerId)).toEqual([
      expect.objectContaining({ status: "canceled" }),
    ]);
    expect(sandbox.destroyed.sort()).toEqual([`sb-side-${suffix}`, `sb-work-${suffix}`]);
    await expect(system.organization.findUnique({ where: { id: work.id } })).resolves.toBeNull();
    await expect(system.space.count({ where: { id: { in: [work.id, side.id] } } })).resolves.toBe(
      0,
    );
    await expect(
      system.computer.count({
        where: { providerRef: { in: [`sb-work-${suffix}`, `sb-side-${suffix}`] } },
      }),
    ).resolves.toBe(0);
    await expect(system.billingAccount.count({ where: { customerId } })).resolves.toBe(0);
    await expect(system.bot.findUnique({ where: { id: kept.id } })).resolves.not.toBeNull();
    await expect(
      system.auditEvent.count({
        where: { organizationId: work.id, action: "organization.deleted" },
      }),
    ).resolves.toBe(1);
    expect((await client(ada).organizations.list()).organizations.map((org) => org.id)).toEqual([
      ada.spaceId,
    ]);
  });

  it("finishes deleting an organization on a retry after a provider fails", async () => {
    const ada = await signup();
    const work = await client(ada).organizations.create({ name: "Work" });
    await botWithComputer(work.id, ada.userId, `sb-retry-${suffix}`);
    sandbox.failDestroy.add(`sb-retry-${suffix}`);

    await expect(client(ada).organizations.remove({ organizationId: work.id })).rejects.toThrow(
      "provider unavailable",
    );
    expect(await system.space.findUnique({ where: { id: work.id } })).toMatchObject({
      deletionClaimId: `organization-deletion:${work.id}`,
    });
    expect((await client(ada).organizations.list()).organizations).toHaveLength(1);

    sandbox.failDestroy.clear();
    await client(ada).organizations.remove({ organizationId: work.id });

    await expect(system.organization.findUnique({ where: { id: work.id } })).resolves.toBeNull();
    expect(sandbox.destroyed).toEqual([`sb-retry-${suffix}`]);
  });

  it("offers a new organization no trial once another of the owner's subscribed", async () => {
    const ada = await signup();
    await expect(billing.status(ada)).resolves.toMatchObject({ trialAvailable: true });
    await subscribe(ada);
    const work = await client(ada).organizations.create({ name: "Work" });
    const inWork = asUser(ada, work.id);

    await expect(billing.status(inWork)).resolves.toMatchObject({ trialAvailable: false });
    await runAsSystem("organizations test", () => billing.checkout(inWork));
    const { customerId } = (await billingAccountForOrganization(system, work.id))!;
    expect(emulator.checkouts.get(customerId)?.trialDays).toBeUndefined();
  });

  it("offers no trial again after the organization that used it is deleted", async () => {
    const ada = await signup();
    const used = await client(ada).organizations.create({ name: "Used" });
    await subscribe(asUser(ada, used.id));
    await client(ada).organizations.remove({ organizationId: used.id });
    const next = await client(ada).organizations.create({ name: "Next" });
    const inNext = asUser(ada, next.id);

    await expect(billing.status(inNext)).resolves.toMatchObject({ trialAvailable: false });
    await expect(billing.status(ada)).resolves.toMatchObject({ trialAvailable: false });
    await runAsSystem("organizations test", () => billing.checkout(inNext));
    const { customerId } = (await billingAccountForOrganization(system, next.id))!;
    expect(emulator.checkouts.get(customerId)?.trialDays).toBeUndefined();
  });

  it("offers a new organization no own-key trial once another of the owner's had free days", async () => {
    const provider = new BillingEmulator({ modelCredits: true, namespace: `orgs-byok-${suffix}` });
    const byok = createBillingService({
      prisma: system,
      provider,
      webOrigin: "https://app.example.test",
    });
    const ada = await signup();
    const work = await client(ada).organizations.create({ name: "Work" });
    const inWork = asUser(ada, work.id);
    await expect(byok.status(inWork)).resolves.toMatchObject({ trialAvailable: true });

    await system.modelCreditAccount.create({ data: { organizationId: ada.spaceId } });
    await system.$transaction((tx) => extendByokFreePeriod(tx, ada.spaceId, 30));

    await expect(byok.status(inWork)).resolves.toMatchObject({ trialAvailable: false });
    await runAsSystem("organizations test", () => byok.selectFunding(inWork, "byok"));
    const { customerId } = (await billingAccountForOrganization(system, work.id))!;
    expect(provider.byokCheckouts.get(customerId)?.trialDays).toBeUndefined();
  });

  it("deletes and cancels every organization of a deleted account", async () => {
    const ada = await signup();
    const work = await client(ada).organizations.create({ name: "Work" });
    const customers = [await subscribe(ada), await subscribe(asUser(ada, work.id))];
    await botWithComputer(work.id, ada.userId, `sb-account-${suffix}`);

    await billing.cancelForDeletedUser(ada.userId);
    await runAsSystem("organizations test", () =>
      deleteAccountContent(deps() as Parameters<typeof deleteAccountContent>[0], ada.userId),
    );

    for (const customerId of customers)
      expect(emulator.subscriptions.filter((sub) => sub.customerId === customerId)).toEqual([
        expect.objectContaining({ status: "canceled" }),
      ]);
    expect((await personalOrganizationIds(system, ada.userId)).sort()).toEqual(
      [ada.spaceId, work.id].sort(),
    );
    await expect(
      system.space.count({ where: { id: { in: [ada.spaceId, work.id] } } }),
    ).resolves.toBe(0);
    expect(sandbox.destroyed).toEqual([`sb-account-${suffix}`]);
  });
});

/** A provider that records destroys. */
function fakeSandbox() {
  const destroyed: string[] = [];
  const failDestroy = new Set<string>();
  return {
    destroyed,
    failDestroy,
    async destroy(computer: ComputerRef) {
      if (failDestroy.has(computer.providerRef)) throw new Error("provider unavailable");
      destroyed.push(computer.providerRef);
    },
    async releaseScreen() {},
  };
}

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
