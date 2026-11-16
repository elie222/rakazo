import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  AgentHomeStore,
  ArtifactStore,
  ComputerRef,
  JobPublisher,
  SandboxProvider,
} from "@rakazo/adapter-kit";
import { deferred } from "@rakazo/core/test-async";
import type { PrismaClient } from "@rakazo/db";
import {
  asSystem,
  bootstrapUserSpace,
  CannotDeleteSpaceAsNonOwnerError,
  claimSpaceDeletionForMember,
  createDb,
  createSpaceForMember,
  runAsTenant,
  SpaceDeletionInProgressError,
} from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { SpaceDeletionDeps } from "./space-deletion.js";
import { deleteSpaceWithContent } from "./space-deletion.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres = process.env.VERIFY_DATABASE && databaseUrl ? describe : describe.skip;

describePostgres("space deletion lease (PostgreSQL)", () => {
  const suffix = `${process.pid}-${Date.now()}-${randomBytes(3).toString("hex")}`;
  const users: string[] = [];
  let sequence = 0;
  let db: ReturnType<typeof createDb>;
  let prisma: PrismaClient;
  let system: PrismaClient;
  let root: string;

  beforeAll(async () => {
    db = createDb(databaseUrl!);
    prisma = db.prisma;
    system = asSystem(prisma);
    root = await mkdtemp(path.join(tmpdir(), "rakazo-space-deletion-"));
  });

  afterAll(async () => {
    if (!db) return;
    await system.organization.deleteMany({
      where: { members: { some: { userId: { in: users } } } },
    });
    await system.user.deleteMany({ where: { id: { in: users } } });
    await rm(root, { recursive: true, force: true });
    await db.prisma.$disconnect();
    await db.pool.end();
  });

  type Owner = { userId: string; defaultSpaceId: string; spaceId: string };

  /** A person with their default Space and a second one they may delete. */
  async function owner(): Promise<Owner> {
    const userId = `space-del-${++sequence}-${suffix}`;
    users.push(userId);
    await system.user.create({
      data: { id: userId, name: userId, email: `${userId}@rakazo.test`, emailVerified: false },
    });
    const { spaceId: defaultSpaceId } = await bootstrapUserSpace(system, { id: userId });
    const { id: spaceId } = await createSpaceForMember(system, {
      currentSpaceId: defaultSpaceId,
      userId,
      name: "Work",
    });
    return { userId, defaultSpaceId, spaceId };
  }

  /** A sandbox still provisioned in the Space, so deleting it has a teardown to hold. */
  async function computerIn(person: Owner, providerRef: string) {
    await system.computer.create({
      data: {
        spaceId: person.spaceId,
        userId: person.userId,
        scope: "team",
        scopeKey: `team:${providerRef}`,
        homeKey: `home-${providerRef}`,
        kind: "fake",
        providerRef,
      },
    });
  }

  function deps(sandbox: Pick<SandboxProvider, "destroy">): SpaceDeletionDeps {
    return {
      prisma,
      sandbox: sandbox as SandboxProvider,
      home: {} as AgentHomeStore,
      jobs: { cancel: vi.fn() } as unknown as JobPublisher,
      memoryProviders: { resolve: async () => null },
      artifacts: { remove: vi.fn() } as unknown as ArtifactStore,
      dataDir: root,
    };
  }

  const remove = (
    sandbox: Pick<SandboxProvider, "destroy">,
    actor: { userId: string; spaceId: string },
    spaceId: string,
  ) =>
    runAsTenant({ spaceId, userId: actor.userId }, () =>
      deleteSpaceWithContent(deps(sandbox), actor, spaceId),
    );

  /** Starts deleting the person's Space and holds it in its sandbox teardown. */
  async function deletionHeldInTeardown(person: Owner) {
    const providerRef = `sb-held-${++sequence}-${suffix}`;
    await computerIn(person, providerRef);
    const entered = deferred();
    const held = deferred();
    const sandbox = {
      destroy: vi.fn(async (_computer: ComputerRef) => {
        entered.resolve();
        await held.promise;
      }),
    };
    const deleting = remove(
      sandbox,
      { userId: person.userId, spaceId: person.defaultSpaceId },
      person.spaceId,
    );
    deleting.catch(() => undefined);
    await entered.promise;
    return { deleting, providerRef, release: () => held.resolve() };
  }

  const leaseKey = (spaceId: string) => `space-deletion:${spaceId}`;
  const leaseRows = async (spaceId: string) => {
    const [row] = await system.$queryRaw<Array<{ rows: bigint }>>`
      SELECT count(*) AS rows FROM "leases" WHERE "key" = ${leaseKey(spaceId)}`;
    return Number(row!.rows);
  };
  /** Hands an attempt's lease to another holder, as if it had lapsed and been taken. */
  const takeLeaseFrom = (spaceId: string) =>
    system.$executeRaw`
      UPDATE "leases" SET "fence" = nextval('leases_fence_seq') WHERE "key" = ${leaseKey(spaceId)}`;

  const nothingToDestroy = { destroy: vi.fn() };

  it("refuses someone who may not delete the Space before taking its lease", async () => {
    const ada = await owner();
    const grace = await owner();
    const { organizationId } = await system.space.findUniqueOrThrow({
      where: { id: ada.spaceId },
    });
    await system.member.create({
      data: {
        id: `m-${grace.userId}`,
        organizationId,
        userId: grace.userId,
        role: "member",
        createdAt: new Date(),
      },
    });
    await system.spaceMember.create({
      data: {
        id: `sm-${grace.userId}`,
        spaceId: ada.spaceId,
        organizationId,
        userId: grace.userId,
        role: "member",
        createdAt: new Date(),
      },
    });
    const asGrace = { userId: grace.userId, spaceId: ada.spaceId };

    await expect(remove(nothingToDestroy, asGrace, ada.spaceId)).rejects.toBeInstanceOf(
      CannotDeleteSpaceAsNonOwnerError,
    );
    await expect(leaseRows(ada.spaceId)).resolves.toBe(0);

    // While the owner's deletion holds the lease, the member still gets the same answer.
    const owners = await deletionHeldInTeardown(ada);
    await expect(remove(nothingToDestroy, asGrace, ada.spaceId)).rejects.toBeInstanceOf(
      CannotDeleteSpaceAsNonOwnerError,
    );
    owners.release();
    await owners.deleting;
    await expect(system.space.findUnique({ where: { id: ada.spaceId } })).resolves.toBeNull();
    await expect(leaseRows(ada.spaceId)).resolves.toBe(0);
  });

  it("refuses a second deletion of the Space while the first holds its lease", async () => {
    const ada = await owner();
    const first = await deletionHeldInTeardown(ada);

    await expect(
      remove(nothingToDestroy, { userId: ada.userId, spaceId: ada.defaultSpaceId }, ada.spaceId),
    ).rejects.toBeInstanceOf(SpaceDeletionInProgressError);

    first.release();
    await expect(first.deleting).resolves.toEqual({ activeSpaceId: ada.defaultSpaceId });
    await expect(system.space.findUnique({ where: { id: ada.spaceId } })).resolves.toBeNull();
    await expect(leaseRows(ada.spaceId)).resolves.toBe(0);
  });

  it("commits no write from an attempt that lost its lease during teardown", async () => {
    const ada = await owner();
    const stale = await deletionHeldInTeardown(ada);

    await takeLeaseFrom(ada.spaceId);
    stale.release();

    await expect(stale.deleting).rejects.toBeInstanceOf(SpaceDeletionInProgressError);
    await expect(system.space.findUnique({ where: { id: ada.spaceId } })).resolves.toMatchObject({
      deletingAt: expect.any(Date),
    });
    // The provider handle stays for whoever holds the lease now.
    await expect(
      system.computer.findFirst({ where: { spaceId: ada.spaceId }, select: { providerRef: true } }),
    ).resolves.toEqual({ providerRef: stale.providerRef });
  });

  it("never runs beside the previous release's deletion of the same Space", async () => {
    const ada = await owner();
    const actor = { userId: ada.userId, spaceId: ada.defaultSpaceId };
    const input = { currentSpaceId: ada.defaultSpaceId, userId: ada.userId, spaceId: ada.spaceId };
    // The previous release claims without a lease row; its live claim refuses this release's
    // attempt, which gives its own lease straight back.
    const previous = await runAsTenant({ spaceId: ada.spaceId, userId: ada.userId }, () =>
      claimSpaceDeletionForMember(prisma, input),
    );
    await expect(remove(nothingToDestroy, actor, ada.spaceId)).rejects.toBeInstanceOf(
      SpaceDeletionInProgressError,
    );
    await expect(leaseRows(ada.spaceId)).resolves.toBe(0);
    await system.space.update({
      where: { id: ada.spaceId },
      data: { deletingAt: null, deletionClaimId: null },
    });
    expect(previous.claimId).toBeTruthy();

    // This release's attempt keeps the Space's claim fresh while it runs, even past the claim
    // timeout, so the previous release's attempt is refused.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const current = await deletionHeldInTeardown(ada);
      const aged = new Date(Date.now() - 10 * 60_000);
      await system.space.update({ where: { id: ada.spaceId }, data: { deletingAt: aged } });
      await vi.advanceTimersByTimeAsync(60_000);
      await vi.waitUntil(async () => {
        const space = await system.space.findUniqueOrThrow({ where: { id: ada.spaceId } });
        return space.deletingAt!.getTime() > aged.getTime();
      });
      await expect(
        runAsTenant({ spaceId: ada.spaceId, userId: ada.userId }, () =>
          claimSpaceDeletionForMember(prisma, input),
        ),
      ).rejects.toBeInstanceOf(SpaceDeletionInProgressError);
      current.release();
      await expect(current.deleting).resolves.toEqual({ activeSpaceId: ada.defaultSpaceId });
    } finally {
      vi.useRealTimers();
    }
    await expect(system.space.findUnique({ where: { id: ada.spaceId } })).resolves.toBeNull();
  });

  it("keeps the claim and the lease of a hung teardown until the teardown settles", async () => {
    const ada = await owner();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const hung = await deletionHeldInTeardown(ada);
      const settled = hung.deleting.then(
        () => "fulfilled" as const,
        (error: unknown) => error,
      );
      await vi.advanceTimersByTimeAsync(120_000);
      await expect(settled).resolves.toMatchObject({ message: "Space sandbox teardown timed out" });
      // The destroy may still reach the provider, so nothing lets another attempt in yet.
      await expect(leaseRows(ada.spaceId)).resolves.toBe(1);
      await expect(
        system.space.findUniqueOrThrow({ where: { id: ada.spaceId } }),
      ).resolves.toMatchObject({
        deletionClaimId: expect.any(String),
        deletingAt: expect.any(Date),
      });

      hung.release();
      await vi.waitUntil(async () => (await leaseRows(ada.spaceId)) === 0);
      await expect(
        system.space.findUniqueOrThrow({ where: { id: ada.spaceId } }),
      ).resolves.toMatchObject({ deletionClaimId: expect.any(String) });
    } finally {
      vi.useRealTimers();
    }
  });
});
