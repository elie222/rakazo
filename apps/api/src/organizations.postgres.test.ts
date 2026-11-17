import { randomBytes, randomUUID } from "node:crypto";
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
import { deferred } from "@rakazo/core/test-async";
import type { PrismaClient, SpaceKeyRecord, SpaceKeyStore } from "@rakazo/db";
import {
  asSystem,
  billingAccountForOrganization,
  bootstrapUserSpace,
  ContentKeyRing,
  claimOrganizationForDeletion,
  createDb,
  deleteClaimedSpace,
  extendByokFreePeriod,
  IsolationError,
  installAuditEventStore,
  LeaseLostError,
  LocalKeyProvider,
  personalOrganizationIds,
  requireMembership,
  runAsSystem,
  setOrganizationDeletionLease,
} from "@rakazo/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryObjectStorage } from "../../../packages/adapters/src/object-storage.test-support.js";
import {
  deleteAccountContent,
  deleteOrganization,
  finishStalledOrganizationDeletions,
} from "./account-deletion.js";
import { createBillingService } from "./billing.js";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres = process.env.VERIFY_DATABASE && databaseUrl ? describe : describe.skip;

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
  const artifacts = { remove: vi.fn(async () => undefined) };

  const deps = () =>
    ({
      prisma,
      env: {},
      sandbox: sandbox as unknown as SandboxProvider,
      home,
      jobs: { cancel: vi.fn(), enqueue: vi.fn() } as unknown as JobPublisher,
      artifacts: artifacts as unknown as ArtifactStore,
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
    const { spaceId } = await bootstrapUserSpace(system, { id: userId });
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
    const created = await system.auditEvent.findMany({
      where: { actorId: { in: users }, action: "organization.created" },
      select: { organizationId: true },
    });
    const leaseKeys = created.map(
      ({ organizationId }) => `organization-deletion:${organizationId}`,
    );
    await system.$executeRaw`DELETE FROM "leases" WHERE "key" = ANY(${leaseKeys})`;
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
        {
          id: ada.spaceId,
          name: "Personal",
          defaultSpaceId: ada.spaceId,
          spaceIds: [ada.spaceId],
          canManage: true,
          role: "owner",
          memberCount: 1,
        },
        {
          id: work.id,
          name: "Work",
          defaultSpaceId: work.id,
          spaceIds: [work.id],
          canManage: true,
          role: "owner",
          memberCount: 1,
        },
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

  it("opens where the user last worked, not where a background helper finished later", async () => {
    const ada = await signup();
    const work = await client(ada).organizations.create({ name: "Work" });
    const finishedRun = async (spaceId: string, trigger: string, completedAt: Date) => {
      const bot = await system.bot.create({
        data: { spaceId, userId: ada.userId, name: trigger, color: "blue" },
      });
      const thread = await system.thread.create({
        data: { spaceId, userId: ada.userId, botId: bot.id },
      });
      const task = await system.task.create({
        data: {
          spaceId,
          botId: bot.id,
          threadId: thread.id,
          userId: ada.userId,
          prompt: trigger,
          status: "completed",
        },
      });
      await system.run.create({
        data: {
          spaceId,
          botId: bot.id,
          threadId: thread.id,
          taskId: task.id,
          userId: ada.userId,
          status: "completed",
          trigger,
          completedAt,
        },
      });
    };
    const start = Date.now();
    await finishedRun(ada.spaceId, "user", new Date(start));
    // A helper started in Work and the turn relaying its result finish after the user moved on.
    await finishedRun(work.id, "helper", new Date(start + 1_000));
    await finishedRun(work.id, "helper_result", new Date(start + 2_000));
    await expect(
      requireMembership(system, { id: ada.userId, email: ada.email }),
    ).resolves.toMatchObject({
      spaceId: ada.spaceId,
    });

    await finishedRun(work.id, "user", new Date(start + 3_000));
    await expect(
      requireMembership(system, { id: ada.userId, email: ada.email }),
    ).resolves.toMatchObject({
      spaceId: work.id,
    });
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

    // One stuck mid-deletion no longer takes a slot.
    const stuck = (results.find(
      (result) => result.status === "fulfilled",
    ) as PromiseFulfilledResult<{
      id: string;
    }>)!.value;
    await system.space.update({ where: { id: stuck.id }, data: { deletingAt: new Date() } });
    await expect(client(ada).organizations.create({ name: "Eleventh" })).resolves.toMatchObject({
      name: "Eleventh",
    });
  });

  it("lists a team organization the user is only a member of, which its owner still manages", async () => {
    const ada = await signup();
    const grace = await signup();
    const team = await client(grace).organizations.create({ name: "Team" });
    await system.member.create({
      data: {
        id: `member-${ada.userId}-team`,
        organizationId: team.id,
        userId: ada.userId,
        role: "member",
        createdAt: new Date(),
      },
    });

    const { organizations } = await client(ada).organizations.list();
    expect(
      organizations.map(({ name, canManage, role, memberCount }) => ({
        name,
        canManage,
        role,
        memberCount,
      })),
    ).toEqual([
      { name: "Personal", canManage: true, role: "owner", memberCount: 1 },
      { name: "Team", canManage: false, role: "member", memberCount: 2 },
    ]);
    expect(organizations[1]?.spaceIds).toEqual([team.defaultSpaceId]);
    await expect(
      client(ada).organizations.rename({ organizationId: team.id, name: "Mine" }),
    ).rejects.toBeInstanceOf(Error);

    // Its owner renames it, but cannot delete it while others belong to it.
    const owner = await client(grace).organizations.list();
    expect(owner.organizations.find((org) => org.id === team.id)?.canManage).toBe(true);
    await expect(
      client(grace).organizations.rename({ organizationId: team.id, name: "Ours" }),
    ).resolves.toEqual({ id: team.id, name: "Ours" });
    await expect(
      client(grace).organizations.remove({ organizationId: team.id }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
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
    const nameError = {
      code: "BAD_REQUEST",
      message: "Organization name must be readable and between 1 and 60 characters",
    };
    await expect(client(ada).organizations.create({ name: "!!!" })).rejects.toMatchObject(
      nameError,
    );
    await expect(
      client(grace).organizations.rename({ organizationId: theirs.id, name: "!!!" }),
    ).rejects.toMatchObject(nameError);

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
      deletionClaimId: expect.stringContaining(`organization-deletion:${work.id}:`),
    });
    expect((await client(ada).organizations.list()).organizations).toHaveLength(1);

    sandbox.failDestroy.clear();
    await client(ada).organizations.remove({ organizationId: work.id });

    await expect(system.organization.findUnique({ where: { id: work.id } })).resolves.toBeNull();
    expect(sandbox.destroyed).toEqual([`sb-retry-${suffix}`]);
  });

  const sweep = (signal = new AbortController().signal) =>
    finishStalledOrganizationDeletions(deps())(signal);

  /** Polls on immediates, which the lease tests leave unfaked while they fake timeouts. */
  async function until(check: () => Promise<boolean> | boolean) {
    const giveUpAt = performance.now() + 5_000;
    while (performance.now() < giveUpAt) {
      if (await check()) return;
      await new Promise(setImmediate);
    }
    throw new Error("condition not reached");
  }

  /** Lapses an attempt's lease and its Spaces' claim, as if it had stopped renewing them. */
  async function lapse(organizationId: string) {
    await system.space.updateMany({
      where: { organizationId },
      data: { deletingAt: new Date(Date.now() - 10 * 60_000) },
    });
    await system.$executeRaw`
      UPDATE "leases" SET "expiresAt" = now() - interval '10 minutes'
      WHERE "key" = ${`organization-deletion:${organizationId}`}`;
  }

  /**
   * Ages the attempt's lease past the claim timeout, as if it had last been renewed minutes ago,
   * then lets one renewal fire on the faked timeout and waits for it to land.
   */
  async function outlastClaimTimeout(organizationId: string) {
    const aged = new Date(Date.now() - 10 * 60_000);
    await system.space.updateMany({ where: { organizationId }, data: { deletingAt: aged } });
    await vi.advanceTimersByTimeAsync(60_000);
    await until(async () => {
      const space = await system.space.findUniqueOrThrow({ where: { id: organizationId } });
      return space.deletingAt!.getTime() > aged.getTime();
    });
  }

  async function failRemoval(actor: Actor, organizationId: string, providerRef: string) {
    sandbox.failDestroy.add(providerRef);
    await expect(client(actor).organizations.remove({ organizationId })).rejects.toThrow(
      "provider unavailable",
    );
    sandbox.failDestroy.delete(providerRef);
  }

  const deletedAudits = (organizationId: string) =>
    system.auditEvent.count({ where: { organizationId, action: "organization.deleted" } });

  const leaseRows = async (key: string) => {
    const [row] = await system.$queryRaw<Array<{ rows: bigint }>>`
      SELECT count(*) AS rows FROM "leases" WHERE "key" = ${key}`;
    return Number(row!.rows);
  };

  /** Hands an attempt's lease to another holder, as if it had lapsed and been taken. */
  const takeLeaseFrom = (organizationId: string) =>
    system.$executeRaw`
      UPDATE "leases" SET "fence" = nextval('leases_fence_seq')
      WHERE "key" = ${`organization-deletion:${organizationId}`}`;

  /** Starts deleting the organization and holds it at its billing call. */
  async function deletionHeldAtBilling(userId: string, organizationId: string) {
    const called = deferred();
    const held = deferred();
    const deleting = runAsSystem("an attempt held at billing", () =>
      deleteOrganization(
        {
          ...deps(),
          billing: {
            cancelForDeletedOrganization: async () => {
              called.resolve();
              await held.promise;
            },
          },
        } as Parameters<typeof deleteOrganization>[0],
        userId,
        organizationId,
      ),
    );
    deleting.catch(() => undefined);
    await called.promise;
    return { deleting, release: () => held.resolve() };
  }

  it("refuses a delete by someone who does not own the organization before taking its lease", async () => {
    const ada = await signup();
    const grace = await signup();
    const work = await client(ada).organizations.create({ name: "Work" });
    const missing = randomUUID();

    await expect(
      client(grace).organizations.remove({ organizationId: missing }),
    ).rejects.toBeInstanceOf(IsolationError);
    await expect(leaseRows(`organization-deletion:${missing}`)).resolves.toBe(0);

    // While the owner's deletion holds the lease, a stranger still sees only that it is not theirs.
    const owners = await deletionHeldAtBilling(ada.userId, work.id);
    await expect(
      client(grace).organizations.remove({ organizationId: work.id }),
    ).rejects.toBeInstanceOf(IsolationError);
    owners.release();
    await owners.deleting;
    await expect(system.organization.findUnique({ where: { id: work.id } })).resolves.toBeNull();
    await expect(leaseRows(`organization-deletion:${work.id}`)).resolves.toBe(0);
  });

  it("commits no Space or organization delete from an attempt that lost its lease", async () => {
    const ada = await signup();
    const work = await client(ada).organizations.create({ name: "Work" });
    const stale = await deletionHeldAtBilling(ada.userId, work.id);

    await takeLeaseFrom(work.id);
    stale.release();

    await expect(stale.deleting).rejects.toBeInstanceOf(LeaseLostError);
    await expect(system.space.findUnique({ where: { id: work.id } })).resolves.not.toBeNull();
    await expect(
      system.organization.findUnique({ where: { id: work.id } }),
    ).resolves.not.toBeNull();
    await expect(deletedAudits(work.id)).resolves.toBe(0);
  });

  it("reports success once the organization went with its last Space, even if the lease is lost after", async () => {
    const ada = await signup();
    const work = await client(ada).organizations.create({ name: "Work" });
    const storageKey = `blob-late-${suffix}`;
    await system.artifact.create({
      data: {
        spaceId: work.id,
        userId: ada.userId,
        name: "plan.txt",
        mimeType: "text/plain",
        size: 4,
        hash: "hash-late",
        storageKey,
      },
    });
    // The second removal is the cleanup after the Space and organization were deleted.
    artifacts.remove.mockImplementationOnce(async () => undefined);
    let tookOver = 0;
    artifacts.remove.mockImplementationOnce(async () => {
      tookOver = await takeLeaseFrom(work.id);
    });

    await client(ada).organizations.remove({ organizationId: work.id });

    expect(tookOver).toBe(1);
    await expect(system.organization.findUnique({ where: { id: work.id } })).resolves.toBeNull();
    await expect(deletedAudits(work.id)).resolves.toBe(1);
  });

  it("finishes a deletion that stopped part way in the background", async () => {
    const ada = await signup();
    const work = await client(ada).organizations.create({ name: "Work" });
    await botWithComputer(work.id, ada.userId, `sb-sweep-${suffix}`);
    await failRemoval(ada, work.id, `sb-sweep-${suffix}`);

    await sweep();

    await expect(system.organization.findUnique({ where: { id: work.id } })).resolves.toBeNull();
    expect(sandbox.destroyed).toContain(`sb-sweep-${suffix}`);
    await expect(deletedAudits(work.id)).resolves.toBe(1);
  });

  it("finishes a deletion whose process crashed midway, once its lease lapses", async () => {
    const ada = await signup();
    const work = await client(ada).organizations.create({ name: "Work" });
    const ref = `sb-crash-${suffix}`;
    await botWithComputer(work.id, ada.userId, ref);
    // A process claimed the organization under its lease, then died before tearing anything down.
    await runAsSystem("a deletion attempt that crashed", () =>
      claimOrganizationForDeletion(system, { userId: ada.userId, organizationId: work.id }),
    );
    await system.$executeRaw`
      INSERT INTO "leases" ("key", "fence", "expiresAt")
      VALUES (
        ${`organization-deletion:${work.id}`},
        nextval('leases_fence_seq'),
        now() + interval '5 minutes'
      )`;
    await system.space.updateMany({
      where: { organizationId: work.id },
      data: { deletingAt: new Date(Date.now() - 10 * 60_000) },
    });

    // Its claim looks stale, but its lease has not lapsed yet: the sweep leaves it alone.
    await sweep();
    expect(sandbox.started).not.toContain(ref);
    await expect(
      system.organization.findUnique({ where: { id: work.id } }),
    ).resolves.not.toBeNull();

    await lapse(work.id);
    await sweep();

    await expect(system.organization.findUnique({ where: { id: work.id } })).resolves.toBeNull();
    expect(sandbox.destroyed).toEqual([ref]);
    await expect(deletedAudits(work.id)).resolves.toBe(1);
  });

  it("never runs beside the previous release's attempt on the same organization", async () => {
    const ada = await signup();
    const work = await client(ada).organizations.create({ name: "Work" });
    const other = await client(ada).organizations.create({ name: "Other" });
    const leaseKey = `organization-deletion:${work.id}`;

    // The previous release claims without a lease row; a live claim refuses this release's attempt,
    // which gives its own lease straight back.
    await runAsSystem("the previous release's attempt", () =>
      claimOrganizationForDeletion(system, { userId: ada.userId, organizationId: work.id }),
    );
    await expect(client(ada).organizations.remove({ organizationId: work.id })).rejects.toThrow(
      "already in progress",
    );
    await expect(leaseRows(leaseKey)).resolves.toBe(0);

    // This release's attempt keeps its Spaces' claim fresh, so the previous release's is refused.
    const called = deferred();
    const held = deferred();
    const current = runAsSystem("this release's attempt", () =>
      deleteOrganization(
        {
          ...deps(),
          billing: {
            cancelForDeletedOrganization: async () => {
              called.resolve();
              await held.promise;
            },
          },
        } as Parameters<typeof deleteOrganization>[0],
        ada.userId,
        other.id,
      ),
    );
    await called.promise;
    await expect(
      runAsSystem("the previous release's attempt", () =>
        claimOrganizationForDeletion(system, { userId: ada.userId, organizationId: other.id }),
      ),
    ).rejects.toThrow("already in progress");
    held.resolve();
    await current;
    await expect(system.organization.findUnique({ where: { id: other.id } })).resolves.toBeNull();
  });

  it("starts no second deletion beside a request whose provider call outlasts the claim timeout", async () => {
    const ada = await signup();
    const work = await client(ada).organizations.create({ name: "Work" });
    const ref = `sb-held-rpc-${suffix}`;
    await botWithComputer(work.id, ada.userId, ref);
    const cancel = vi.spyOn(billing, "cancelForDeletedOrganization");
    const release = sandbox.hold(ref);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const removing = client(ada).organizations.remove({ organizationId: work.id });
      await until(() => sandbox.started.includes(ref));
      await outlastClaimTimeout(work.id);

      await sweep();
      await expect(client(ada).organizations.remove({ organizationId: work.id })).rejects.toThrow(
        "already in progress",
      );
      release();
      await removing;
    } finally {
      vi.useRealTimers();
    }

    expect(cancel.mock.calls.filter(([id]) => id === work.id)).toHaveLength(1);
    expect(sandbox.started.filter((started) => started === ref)).toHaveLength(1);
    await expect(deletedAudits(work.id)).resolves.toBe(1);
  });

  it("lets one sweep at a time resume a deletion whose provider call outlasts the claim timeout", async () => {
    const ada = await signup();
    const work = await client(ada).organizations.create({ name: "Work" });
    const ref = `sb-held-sweep-${suffix}`;
    await botWithComputer(work.id, ada.userId, ref);
    await failRemoval(ada, work.id, ref);
    const cancel = vi.spyOn(billing, "cancelForDeletedOrganization");
    const release = sandbox.hold(ref);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const first = sweep();
      await until(() => sandbox.started.includes(ref));
      await outlastClaimTimeout(work.id);

      await sweep();
      release();
      await first;
    } finally {
      vi.useRealTimers();
    }

    await expect(system.organization.findUnique({ where: { id: work.id } })).resolves.toBeNull();
    expect(cancel.mock.calls.filter(([id]) => id === work.id)).toHaveLength(1);
    expect(sandbox.started.filter((started) => started === ref)).toHaveLength(1);
    await expect(deletedAudits(work.id)).resolves.toBe(1);
  });

  it("finishes one stalled deletion while another's provider call hangs", async () => {
    const ada = await signup();
    const hung = await client(ada).organizations.create({ name: "Hung" });
    const other = await client(ada).organizations.create({ name: "Other" });
    const hungRef = `sb-hung-${suffix}`;
    await botWithComputer(hung.id, ada.userId, hungRef);
    await botWithComputer(other.id, ada.userId, `sb-other-${suffix}`);
    await failRemoval(ada, hung.id, hungRef);
    await failRemoval(ada, other.id, `sb-other-${suffix}`);
    const release = sandbox.hold(hungRef);
    const stopping = new AbortController();

    const running = sweep(stopping.signal);
    await until(async () => !(await system.organization.findUnique({ where: { id: other.id } })));
    await until(() => sandbox.started.includes(hungRef));
    stopping.abort();
    await running;

    // Cut off mid-call, the attempt keeps its lease until it lapses.
    expect(await system.space.findUnique({ where: { id: hung.id } })).toMatchObject({
      deletionClaimId: expect.stringContaining(`organization-deletion:${hung.id}:`),
      deletingAt: expect.any(Date),
    });
    const space = await system.space.findUniqueOrThrow({ where: { id: hung.id } });
    expect(space.deletingAt!.getTime()).toBeGreaterThan(Date.now() - 60_000);
    release();
    await until(() => sandbox.destroyed.includes(hungRef));
  });

  it("hands the claim back when its deadline passes while the claim is being taken", async () => {
    const ada = await signup();
    const work = await client(ada).organizations.create({ name: "Work" });
    const claiming = deferred();
    const held = deferred();
    const deadline = new AbortController();
    // The claim is the attempt's first transaction; hold it open until the deadline has passed.
    let first = true;
    const holdingClaim = new Proxy(prisma, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (property !== "$transaction" || typeof value !== "function") return value;
        return async (...args: unknown[]) => {
          if (first) {
            first = false;
            claiming.resolve();
            await held.promise;
          }
          return value.apply(target, args);
        };
      },
    }) as PrismaClient;
    const late = runAsSystem("an attempt cut off while claiming", () =>
      deleteOrganization(
        { ...deps(), prisma: holdingClaim } as Parameters<typeof deleteOrganization>[0],
        ada.userId,
        work.id,
        deadline.signal,
      ),
    );
    await claiming.promise;
    deadline.abort(new Error("Organization deletion timed out"));
    await expect(late).rejects.toThrow("timed out");
    held.resolve();
    // Once the late claim lands it is handed back and the attempt lets its lease go, so a retry
    // starts at once instead of being turned away until the claim lapses.
    await vi.waitFor(
      async () => {
        const [lease] = await system.$queryRaw<unknown[]>`
          SELECT 1 FROM "leases" WHERE "key" = ${`organization-deletion:${work.id}`}`;
        expect(lease).toBeUndefined();
        const spaces = await system.space.findMany({ where: { organizationId: work.id } });
        expect(
          spaces.every((space) => !space.deletingAt || space.deletingAt.getTime() < 1000),
        ).toBe(true);
      },
      { timeout: 5_000, interval: 20 },
    );
    await client(ada).organizations.remove({ organizationId: work.id });
    expect(await system.organization.findUnique({ where: { id: work.id } })).toBeNull();
  });

  it("starts no teardown from an attempt whose billing call returns after its deadline", async () => {
    const ada = await signup();
    const work = await client(ada).organizations.create({ name: "Work" });
    const ref = `sb-late-${suffix}`;
    await botWithComputer(work.id, ada.userId, ref);
    const called = deferred();
    const held = deferred();
    const deadline = new AbortController();
    // Going on after its deadline, the attempt's next step would be a query; record any it makes.
    let billingReturned = false;
    const queriesAfterBilling: string[] = [];
    const late = runAsSystem("an attempt cut off at its deadline", () =>
      deleteOrganization(
        {
          ...deps(),
          prisma: recordingQueries(prisma, () => billingReturned, queriesAfterBilling),
          billing: {
            cancelForDeletedOrganization: async () => {
              called.resolve();
              await held.promise;
            },
          },
        } as Parameters<typeof deleteOrganization>[0],
        ada.userId,
        work.id,
        deadline.signal,
      ),
    );
    await called.promise;
    deadline.abort(new Error("Organization deletion timed out"));
    await expect(late).rejects.toThrow("timed out");
    // Its lease lapses, and a retry takes over and starts tearing the bot down.
    await lapse(work.id);
    const release = sandbox.hold(ref);
    const retry = client(ada).organizations.remove({ organizationId: work.id });
    await until(() => sandbox.started.includes(ref));

    billingReturned = true;
    held.resolve();
    // The cut-off attempt resumes within these microtasks, so by now it has stopped or gone on.
    await new Promise(setImmediate);
    expect(queriesAfterBilling).toEqual([]);
    expect(sandbox.started.filter((started) => started === ref)).toHaveLength(1);
    release();
    await retry;

    await expect(system.organization.findUnique({ where: { id: work.id } })).resolves.toBeNull();
    expect(sandbox.started.filter((started) => started === ref)).toHaveLength(1);
  });

  it("starts no teardown from an attempt whose claim another attempt took while billing waited", async () => {
    const ada = await signup();
    const work = await client(ada).organizations.create({ name: "Work" });
    const ref = `sb-lost-${suffix}`;
    await botWithComputer(work.id, ada.userId, ref);
    const called = deferred();
    const held = deferred();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const stale = runAsSystem("an attempt whose renewals stopped landing", () =>
        deleteOrganization(
          {
            ...deps(),
            billing: {
              cancelForDeletedOrganization: async () => {
                called.resolve();
                await held.promise;
              },
            },
          } as Parameters<typeof deleteOrganization>[0],
          ada.userId,
          work.id,
        ),
      );
      stale.catch(() => undefined);
      await called.promise;
      // Its lease lapses, and a retry takes the claim over and starts tearing the bot down.
      await lapse(work.id);
      const release = sandbox.hold(ref);
      const retry = client(ada).organizations.remove({ organizationId: work.id });
      await until(() => sandbox.started.includes(ref));

      // The first attempt's next renewal finds the lease taken; then its billing call returns.
      const stopped = expect(stale).rejects.toBeInstanceOf(LeaseLostError);
      await vi.advanceTimersByTimeAsync(60_000);
      await stopped;
      held.resolve();
      await new Promise(setImmediate);
      expect(sandbox.started.filter((started) => started === ref)).toHaveLength(1);
      release();
      await retry;
    } finally {
      vi.useRealTimers();
    }

    await expect(system.organization.findUnique({ where: { id: work.id } })).resolves.toBeNull();
    expect(sandbox.started.filter((started) => started === ref)).toHaveLength(1);
  });

  it("takes over a claim the previous release left, keeping it when billing fails", async () => {
    const ada = await signup();
    const work = await client(ada).organizations.create({ name: "Work" });
    await subscribe(asUser(ada, work.id));
    // A deletion that stalled under the previous release's bare claim id.
    await system.space.updateMany({
      where: { organizationId: work.id },
      data: {
        deletionClaimId: `organization-deletion:${work.id}`,
        deletingAt: new Date(Date.now() - 10 * 60_000),
      },
    });
    vi.spyOn(emulator, "cancelCustomerSubscriptions").mockRejectedValueOnce(
      new Error("billing unavailable"),
    );

    await expect(client(ada).organizations.remove({ organizationId: work.id })).rejects.toThrow(
      "billing unavailable",
    );

    expect(await system.space.findUnique({ where: { id: work.id } })).toMatchObject({
      deletingAt: expect.any(Date),
      deletionClaimId: expect.stringContaining(`organization-deletion:${work.id}:`),
    });
    expect((await client(ada).organizations.list()).organizations).toHaveLength(1);
  });

  it("takes over an account deletion's lapsed claim, keeping it when billing fails", async () => {
    const ada = await signup();
    const work = await client(ada).organizations.create({ name: "Work" });
    await subscribe(asUser(ada, work.id));
    // An account deletion that stalled after claiming the Space.
    await system.space.updateMany({
      where: { organizationId: work.id },
      data: {
        deletionClaimId: `account-deletion:${ada.userId}`,
        deletionAttemptId: "account-attempt",
        deletingAt: new Date(Date.now() - 10 * 60_000),
      },
    });
    vi.spyOn(emulator, "cancelCustomerSubscriptions").mockRejectedValueOnce(
      new Error("billing unavailable"),
    );

    await expect(client(ada).organizations.remove({ organizationId: work.id })).rejects.toThrow(
      "billing unavailable",
    );

    // Parked, not released: the lease is at the epoch and the account attempt id is gone.
    expect(await system.space.findUnique({ where: { id: work.id } })).toMatchObject({
      deletingAt: new Date(0),
      deletionAttemptId: null,
      deletionClaimId: expect.stringContaining(`organization-deletion:${work.id}:`),
    });
    expect((await client(ada).organizations.list()).organizations).toHaveLength(1);
  });

  it("deletes the organization with its last Space, so no crash leaves it without its claim", async () => {
    const ada = await signup();
    const work = await client(ada).organizations.create({ name: "Work" });

    await runAsSystem("delete the last Space", async () => {
      const { claimId } = await claimOrganizationForDeletion(system, {
        userId: ada.userId,
        organizationId: work.id,
      });
      await deleteClaimedSpace(system, { spaceId: work.id, claimId, organizationId: work.id });
    });

    await expect(system.organization.findUnique({ where: { id: work.id } })).resolves.toBeNull();
  });

  it("keeps a Space whose files could not be removed, and removes them on a retry", async () => {
    const ada = await signup();
    const work = await client(ada).organizations.create({ name: "Work" });
    const storageKey = `blob-org-${suffix}`;
    await system.artifact.create({
      data: {
        spaceId: work.id,
        userId: ada.userId,
        name: "plan.txt",
        mimeType: "text/plain",
        size: 4,
        hash: "hash-org",
        storageKey,
      },
    });
    artifacts.remove.mockRejectedValueOnce(new Error("storage unavailable"));

    await expect(client(ada).organizations.remove({ organizationId: work.id })).rejects.toThrow(
      "storage unavailable",
    );
    expect(await system.space.findUnique({ where: { id: work.id } })).not.toBeNull();

    await client(ada).organizations.remove({ organizationId: work.id });

    await expect(system.organization.findUnique({ where: { id: work.id } })).resolves.toBeNull();
    expect(artifacts.remove).toHaveBeenLastCalledWith(
      storageKey,
      expect.objectContaining({ spaceId: work.id }),
    );
  });

  it("hides nothing when cancelling the organization's billing fails", async () => {
    const ada = await signup();
    const work = await client(ada).organizations.create({ name: "Work" });
    await subscribe(asUser(ada, work.id));
    vi.spyOn(emulator, "cancelCustomerSubscriptions").mockRejectedValueOnce(
      new Error("billing unavailable"),
    );

    await expect(client(ada).organizations.remove({ organizationId: work.id })).rejects.toThrow(
      "billing unavailable",
    );

    expect((await client(ada).organizations.list()).organizations.map((org) => org.id)).toEqual([
      ada.spaceId,
      work.id,
    ]);
    expect(await system.space.findUnique({ where: { id: work.id } })).toMatchObject({
      deletionClaimId: null,
      deletingAt: null,
    });
  });

  it("leaves another attempt's claim in place when a joining attempt's billing fails", async () => {
    const ada = await signup();
    const work = await client(ada).organizations.create({ name: "Work" });
    await subscribe(asUser(ada, work.id));
    await runAsSystem("an earlier deletion attempt", async () => {
      const { claimId } = await claimOrganizationForDeletion(system, {
        userId: ada.userId,
        organizationId: work.id,
      });
      // That attempt stopped, so its lease lapsed.
      await setOrganizationDeletionLease(system, {
        organizationId: work.id,
        claimId,
        at: new Date(0),
      });
    });
    vi.spyOn(emulator, "cancelCustomerSubscriptions").mockRejectedValueOnce(
      new Error("billing unavailable"),
    );

    await expect(client(ada).organizations.remove({ organizationId: work.id })).rejects.toThrow(
      "billing unavailable",
    );

    expect(await system.space.findUnique({ where: { id: work.id } })).toMatchObject({
      deletingAt: expect.any(Date),
      deletionClaimId: expect.stringContaining(`organization-deletion:${work.id}:`),
    });
  });

  it("keeps the claim another attempt took over when the placing attempt's billing fails", async () => {
    const ada = await signup();
    const work = await client(ada).organizations.create({ name: "Work" });
    await subscribe(asUser(ada, work.id));
    await botWithComputer(work.id, ada.userId, `sb-takeover-${suffix}`);
    sandbox.failDestroy.add(`sb-takeover-${suffix}`);

    // The placing attempt stalls in billing, after its claim is in place.
    const placed = deferred();
    const stalled = deferred();
    const placing = runAsSystem("an earlier deletion attempt", () =>
      deleteOrganization(
        {
          ...deps(),
          billing: {
            cancelForDeletedOrganization: async () => {
              placed.resolve();
              await stalled.promise;
              throw new Error("billing unavailable");
            },
          },
        } as Parameters<typeof deleteOrganization>[0],
        ada.userId,
        work.id,
      ),
    );
    await placed.promise;
    // Its lease lapses, as if it had stopped renewing it.
    await lapse(work.id);

    // Another attempt takes the claim over and gets stuck destroying the bot.
    await expect(client(ada).organizations.remove({ organizationId: work.id })).rejects.toThrow(
      "provider unavailable",
    );

    stalled.resolve();
    await expect(placing).rejects.toThrow("billing unavailable");

    expect(await system.space.findUnique({ where: { id: work.id } })).toMatchObject({
      deletingAt: expect.any(Date),
      deletionClaimId: expect.any(String),
    });
    expect((await client(ada).organizations.list()).organizations).toHaveLength(1);

    // Deleting again finishes what the stuck attempt left behind.
    sandbox.failDestroy.clear();
    await client(ada).organizations.remove({ organizationId: work.id });

    await expect(system.organization.findUnique({ where: { id: work.id } })).resolves.toBeNull();
    expect(sandbox.destroyed).toEqual([`sb-takeover-${suffix}`]);
  });

  it("deletes only one of two organizations removed at once, leaving the other's billing live", async () => {
    const ada = await signup();
    const work = await client(ada).organizations.create({ name: "Work" });
    const customers = [await subscribe(ada), await subscribe(asUser(ada, work.id))];

    const results = await Promise.allSettled([
      client(ada).organizations.remove({ organizationId: ada.spaceId }),
      client(ada).organizations.remove({ organizationId: work.id }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const live = customers[results[0].status === "fulfilled" ? 1 : 0];
    expect(emulator.subscriptions.filter((sub) => sub.customerId === live)).toEqual([
      expect.objectContaining({ status: "active" }),
    ]);
  });

  it("never leaves a Space created during an organization's deletion behind", async () => {
    const ada = await signup();
    const work = await client(ada).organizations.create({ name: "Work" });
    const inWork = client(asUser(ada, work.id));

    const [removed] = await Promise.allSettled([
      client(ada).organizations.remove({ organizationId: work.id }),
      inWork.spaces.create({ name: "Late" }),
    ]);

    expect(removed.status).toBe("fulfilled");
    expect(await prisma.organization.findUnique({ where: { id: work.id } })).toBeNull();
    expect(await prisma.space.count({ where: { organizationId: work.id } })).toBe(0);
  });

  it("never deletes an organization someone else is a member of", async () => {
    const ada = await signup();
    const grace = await signup();
    const work = await client(ada).organizations.create({ name: "Work" });
    await system.member.create({
      data: {
        id: `member-${grace.userId}`,
        organizationId: work.id,
        userId: grace.userId,
        role: "member",
        createdAt: new Date(),
      },
    });

    await expect(
      client(ada).organizations.remove({ organizationId: work.id }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(await system.space.findUnique({ where: { id: work.id } })).toMatchObject({
      deletionClaimId: null,
    });
  });

  it("shows a team member the owner's trial, not their own", async () => {
    const ada = await signup();
    const grace = await signup();
    await subscribe(grace);
    const team = await client(grace).organizations.create({ name: "Team" });
    await system.member.create({
      data: {
        id: `member-${ada.userId}-trial-team`,
        organizationId: team.id,
        userId: ada.userId,
        role: "member",
        createdAt: new Date(),
      },
    });

    await expect(billing.status(ada)).resolves.toMatchObject({ trialAvailable: true });
    await expect(billing.status(asUser(ada, team.defaultSpaceId))).resolves.toMatchObject({
      trialAvailable: false,
    });
  });

  it("refuses a checkout for an organization being deleted", async () => {
    const ada = await signup();
    const work = await client(ada).organizations.create({ name: "Work" });
    await system.space.update({ where: { id: work.id }, data: { deletingAt: new Date() } });

    await expect(
      runAsSystem("organizations test", () => billing.checkout(asUser(ada, work.id))),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await billingAccountForOrganization(system, work.id)).toBeNull();
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

  it("keeps the trial used by a deleted organization from before the user-level mark", async () => {
    const ada = await signup();
    const used = await client(ada).organizations.create({ name: "Used" });
    await subscribe(asUser(ada, used.id));
    await system.user.update({ where: { id: ada.userId }, data: { billingTrialUsedAt: null } });

    await client(ada).organizations.remove({ organizationId: used.id });
    const next = await client(ada).organizations.create({ name: "Next" });

    await expect(
      system.user.findUniqueOrThrow({ where: { id: ada.userId } }),
    ).resolves.toMatchObject({ billingTrialUsedAt: expect.any(Date) });
    await expect(billing.status(asUser(ada, next.id))).resolves.toMatchObject({
      trialAvailable: false,
    });
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

  it("still offers the managed plan's trial after free own-key days", async () => {
    const ada = await signup();
    const work = await client(ada).organizations.create({ name: "Work" });
    const inWork = asUser(ada, work.id);
    await system.modelCreditAccount.create({ data: { organizationId: ada.spaceId } });
    await system.$transaction((tx) => extendByokFreePeriod(tx, ada.spaceId, 30));

    await expect(
      system.user.findUniqueOrThrow({ where: { id: ada.userId } }),
    ).resolves.toMatchObject({ billingTrialUsedAt: null });
    await expect(billing.status(inWork)).resolves.toMatchObject({ trialAvailable: true });
    await runAsSystem("organizations test", () => billing.checkout(inWork));
    const { customerId } = (await billingAccountForOrganization(system, work.id))!;
    expect(emulator.checkouts.get(customerId)?.trialDays).toEqual(expect.any(Number));
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
  const started: string[] = [];
  const failDestroy = new Set<string>();
  const held = new Map<string, Promise<void>>();
  return {
    destroyed,
    started,
    failDestroy,
    /** Keeps destroying this sandbox pending until the returned release is called. */
    hold(providerRef: string) {
      const gate = deferred();
      held.set(providerRef, gate.promise);
      return () => gate.resolve();
    },
    async destroy(computer: ComputerRef) {
      if (failDestroy.has(computer.providerRef)) throw new Error("provider unavailable");
      started.push(computer.providerRef);
      await held.get(computer.providerRef);
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

/** `prisma`, recording each model query made while `recording()` is true. */
function recordingQueries(
  prisma: PrismaClient,
  recording: () => boolean,
  queries: string[],
): PrismaClient {
  return new Proxy(prisma, {
    get(target, model, receiver) {
      const delegate = Reflect.get(target, model, receiver);
      // Raw queries read the client's internals (`_extensions` and the like) through the proxy.
      if (typeof model !== "string" || /^[$_]/.test(model) || typeof delegate !== "object")
        return delegate;
      return new Proxy(delegate, {
        get(methods, method, methodsReceiver) {
          const query = Reflect.get(methods, method, methodsReceiver);
          if (typeof query !== "function") return query;
          return (...args: unknown[]) => {
            if (recording()) queries.push(`${model}.${String(method)}`);
            return query.apply(methods, args);
          };
        },
      });
    },
  });
}
