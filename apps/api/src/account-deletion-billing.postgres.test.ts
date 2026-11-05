import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ArtifactStore, JobPublisher } from "@rakazo/adapter-kit";
import { BillingEmulator } from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { asSystem, createDb, runAsSystem, SPACE_DELETION_CLAIM_TIMEOUT_MS } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { deleteAccountContent } from "./account-deletion.js";
import { createBillingService } from "./billing.js";
import type { SpaceDeletionDeps } from "./space-deletion.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Holds the provider's checkout call until the test releases it, so its lease stays held. */
class GatedCheckoutEmulator extends BillingEmulator {
  private readonly entered = deferred();
  private readonly gate = deferred();

  get providerCallStarted() {
    return this.entered.promise;
  }

  releaseCheckout() {
    this.gate.resolve();
  }

  override async createCheckout(input: { customerId: string; seats: number }) {
    this.entered.resolve();
    await this.gate.promise;
    return super.createCheckout(input as never);
  }
}

/** A provider whose cancellation always fails, so the account deletion aborts at billing. */
class FailingCancelEmulator extends BillingEmulator {
  override async cancelCustomerSubscriptions() {
    throw new Error("provider unavailable");
  }
}

describePostgres("account deletion billing ordering (PostgreSQL)", () => {
  const stamp = `${process.pid}-${Date.now()}`;
  const userId = `acct-billing-${stamp}`;
  const email = `acct-billing-${stamp}@rakazo.test`;
  const organizationIds: string[] = [];
  let prisma: PrismaClient, db: ReturnType<typeof createDb>, root: string;

  beforeAll(async () => {
    db = createDb(databaseUrl!);
    prisma = db.prisma;
    root = await mkdtemp(path.join(tmpdir(), "rakazo-acct-billing-"));
    await asSystem(prisma).user.create({
      data: { id: userId, name: "Account billing", email, emailVerified: false },
    });
  });

  afterAll(async () => {
    await prisma.organization.deleteMany({ where: { id: { in: organizationIds } } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await db.prisma.$disconnect();
    await db.pool.end();
    await rm(root, { recursive: true, force: true });
  });

  /** A personal organization of the account, addressed through its default space. */
  async function organization(name: string) {
    const organizationId = `acct-billing-${name}-${stamp}`;
    const spaceId = `acct-billing-${name}-space-${stamp}`;
    organizationIds.push(organizationId);
    const createdAt = new Date();
    await prisma.organization.create({
      data: {
        id: organizationId,
        name: `Account billing ${name}`,
        slug: organizationId,
        createdAt,
      },
    });
    await prisma.space.create({
      data: { id: spaceId, organizationId, name: "Personal", isDefault: true },
    });
    await prisma.member.create({
      data: {
        id: `acct-billing-${name}-member-${stamp}`,
        organizationId,
        userId,
        role: "owner",
        createdAt,
      },
    });
    const actor: Actor = { userId, spaceId, email, isDeploymentOwner: false };
    return { organizationId, actor };
  }

  function deletionDeps(billing: ReturnType<typeof createBillingService>) {
    return {
      prisma,
      sandbox: { destroy: vi.fn() },
      home: {},
      jobs: { cancel: vi.fn() } as unknown as JobPublisher,
      artifacts: { remove: vi.fn() } as unknown as ArtifactStore,
      dataDir: root,
      billing,
    } as unknown as SpaceDeletionDeps & { billing: ReturnType<typeof createBillingService> };
  }

  it("refuses a checkout opened while the account's billing cancellation is still running", async () => {
    const second = await organization("second");
    const first = await organization("first");
    const provider = new GatedCheckoutEmulator({ namespace: `acct-billing-${stamp}` });
    const service = createBillingService({ prisma, provider, webOrigin: "https://example.test" });
    // One checkout is still opening for the second organization, holding its lease, so the
    // account's cancellation cannot finish while the test probes the first organization.
    const pending = service.checkout(second.actor);
    await provider.providerCallStarted;
    const deleting = runAsSystem("account deletion billing test", () =>
      deleteAccountContent(deletionDeps(service), userId),
    );
    // Wait until the deletion has claimed the account's spaces before probing.
    await vi.waitFor(async () => {
      const claimed = await prisma.space.findFirst({
        where: { organizationId: first.organizationId, deletingAt: { not: null } },
        select: { id: true },
      });
      expect(claimed).not.toBeNull();
    });
    // The first organization's cancellation has finished or is waiting behind the second one;
    // either way its spaces are claimed, so no payable checkout may open for it.
    await expect(service.checkout(first.actor)).rejects.toMatchObject({ code: "CONFLICT" });
    provider.releaseCheckout();
    await expect(pending).resolves.toMatchObject({ url: expect.any(String) });
    await deleting;
    for (const { organizationId } of [first, second])
      await expect(prisma.space.findFirst({ where: { organizationId } })).resolves.toBeNull();
  });

  it("rolls back only the claims this attempt took over", async () => {
    const earlier = await organization("earlier");
    const stale = await organization("stale");
    const fresh = await organization("freshroll");
    const accountClaim = `account-deletion:${userId}`;
    const staleMarker = `organization-deletion:${stale.organizationId}`;
    const staleAt = new Date(Date.now() - SPACE_DELETION_CLAIM_TIMEOUT_MS - 60_000);
    // A retry of a deletion that already failed mid-teardown keeps its earlier claim; the
    // stale marker belongs to a stalled organization deletion that may still resume.
    await prisma.space.updateMany({
      where: { organizationId: earlier.organizationId },
      data: { deletionClaimId: accountClaim, deletingAt: new Date() },
    });
    await prisma.space.updateMany({
      where: { organizationId: stale.organizationId },
      data: { deletionClaimId: staleMarker, deletingAt: staleAt },
    });
    const service = createBillingService({
      prisma,
      provider: new FailingCancelEmulator({ namespace: `acct-billing-takeover-${stamp}` }),
      webOrigin: "https://example.test",
    });
    await expect(
      runAsSystem("account deletion billing test", () =>
        deleteAccountContent(deletionDeps(service), userId),
      ),
    ).rejects.toThrow("provider unavailable");
    await expect(
      prisma.space.findFirst({ where: { organizationId: earlier.organizationId } }),
    ).resolves.toMatchObject({ deletionClaimId: accountClaim, deletingAt: expect.any(Date) });
    await expect(
      prisma.space.findFirst({ where: { organizationId: stale.organizationId } }),
    ).resolves.toMatchObject({ deletionClaimId: staleMarker, deletingAt: staleAt });
    await expect(
      prisma.space.findFirst({ where: { organizationId: fresh.organizationId } }),
    ).resolves.toMatchObject({ deletionClaimId: null, deletingAt: null });
  });

  it("undoes the account's claims when the billing cancellation fails", async () => {
    const only = await organization("rollback");
    const service = createBillingService({
      prisma,
      provider: new FailingCancelEmulator({ namespace: `acct-billing-fail-${stamp}` }),
      webOrigin: "https://example.test",
    });
    await expect(
      runAsSystem("account deletion billing test", () =>
        deleteAccountContent(deletionDeps(service), userId),
      ),
    ).rejects.toThrow("provider unavailable");
    await expect(
      prisma.space.findFirst({ where: { organizationId: only.organizationId } }),
    ).resolves.toMatchObject({ deletingAt: null, deletionClaimId: null });
    await expect(
      prisma.organization.findUnique({ where: { id: only.organizationId } }),
    ).resolves.not.toBeNull();
  });
});
