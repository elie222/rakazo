import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "../database/client.js";
import { createDb } from "../database/client.js";
import { asSystem } from "../database/row-security.js";
import {
  claimFirstGrantSpend,
  grantModelCredit,
  modelCreditGrantId,
} from "./model-credit-grant.js";
import { creditAccount, reserveModelCredits } from "./model-credits.js";

const dbTests = process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe : describe.skip;
dbTests("model credit grant", () => {
  const stamp = `grant-${process.pid}-${Date.now()}`;
  const ids: string[] = [];
  let db: ReturnType<typeof createDb>;
  let prisma: PrismaClient;
  beforeAll(() => {
    db = createDb(process.env.DATABASE_URL!);
    prisma = asSystem(db.prisma);
  });
  afterAll(async () => {
    await prisma.organization.deleteMany({ where: { id: { startsWith: stamp } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
    await db.prisma.$disconnect();
    await db.pool.end();
  });

  /** An organization on a running own-key plan, owned by `owner` (a new person by default). */
  async function ownKeyPlan(
    label: string,
    plan: { status?: string; cancelAtPeriodEnd?: boolean; creditAmountCents?: number } = {},
    owner = `${stamp}-${label}`,
  ) {
    const id = `${stamp}-${label}`;
    if (owner === id) {
      ids.push(owner);
      await prisma.user.create({
        data: { id: owner, name: "Alex", email: `${owner}@example.test`, emailVerified: true },
      });
    }
    await prisma.organization.create({
      data: { id, name: "Example", slug: id, createdAt: new Date() },
    });
    await prisma.member.create({
      data: { id, organizationId: id, userId: owner, role: "owner", createdAt: new Date() },
    });
    await prisma.billingAccount.create({
      data: {
        organizationId: id,
        customerId: `${id}-customer`,
        status: plan.status ?? "trialing",
        cancelAtPeriodEnd: plan.cancelAtPeriodEnd ?? false,
        creditAmountCents: plan.creditAmountCents ?? null,
      },
    });
    await creditAccount(prisma, id);
    await prisma.modelCreditAccount.update({
      where: { organizationId: id },
      data: { mode: "byok" },
    });
    return { organizationId: id, ownerUserId: owner };
  }
  const balance = async (organizationId: string) =>
    (await creditAccount(prisma, organizationId)).balanceMicros;

  it("gives an organization one grant however many times it is asked, journalled as a grant", async () => {
    const target = await ownKeyPlan("once");
    const results = await Promise.all(
      Array.from({ length: 4 }, () => grantModelCredit(prisma, target)),
    );
    expect(results.sort()).toEqual([
      "already-granted",
      "already-granted",
      "already-granted",
      "granted",
    ]);
    expect(await grantModelCredit(prisma, target)).toBe("already-granted");
    expect(await balance(target.organizationId)).toBe(2_000_000n);
    const id = modelCreditGrantId(target.organizationId);
    expect(await prisma.modelCreditLot.findUnique({ where: { id } })).toMatchObject({
      amountMicros: 2_000_000n,
      availableMicros: 2_000_000n,
      expiresAt: null,
    });
    const journal = await prisma.billingAuditEvent.findMany({
      where: { organizationId: target.organizationId, kind: "grant" },
    });
    expect(journal).toEqual([expect.objectContaining({ amountMicros: 2_000_000n })]);
    expect(
      (await prisma.user.findUnique({ where: { id: target.ownerUserId } }))?.modelCreditGrantedAt,
    ).toBeInstanceOf(Date);
  });

  it("gives an owner one grant across their organizations", async () => {
    const first = await ownKeyPlan("owner-first");
    const second = await ownKeyPlan("owner-second", {}, first.ownerUserId);
    expect(await grantModelCredit(prisma, first)).toBe("granted");
    expect(await grantModelCredit(prisma, second)).toBe("ineligible");
    expect(await balance(second.organizationId)).toBe(0n);
  });

  it.each([
    ["an ended plan", { status: "canceled" }],
    ["an unpaid plan", { status: "unpaid" }],
    ["a cancelling trial", { cancelAtPeriodEnd: true }],
    ["a plan with monthly credits", { creditAmountCents: 2000 }],
  ])("gives nothing to %s", async (label, plan) => {
    const target = await ownKeyPlan(label.replaceAll(" ", "-"), plan);
    expect(await grantModelCredit(prisma, target)).toBe("ineligible");
    expect(await balance(target.organizationId)).toBe(0n);
    expect(
      (await prisma.user.findUnique({ where: { id: target.ownerUserId } }))?.modelCreditGrantedAt,
    ).toBeNull();
  });

  it("gives nothing to an organization on hosted credits, or to someone who is not its owner", async () => {
    const credits = await ownKeyPlan("credits-mode");
    await prisma.modelCreditAccount.update({
      where: { organizationId: credits.organizationId },
      data: { mode: "credits" },
    });
    expect(await grantModelCredit(prisma, credits)).toBe("ineligible");
    const demoted = await ownKeyPlan("demoted");
    await prisma.member.update({ where: { id: demoted.organizationId }, data: { role: "member" } });
    expect(await grantModelCredit(prisma, demoted)).toBe("ineligible");
  });

  it("records the grant's first spend once", async () => {
    const target = await ownKeyPlan("spend");
    await grantModelCredit(prisma, target);
    expect(await claimFirstGrantSpend(prisma, target.organizationId)).toBe(false);
    await reserveModelCredits(prisma, target.organizationId, 0.05);
    const claims = await Promise.all([
      claimFirstGrantSpend(prisma, target.organizationId),
      claimFirstGrantSpend(prisma, target.organizationId),
    ]);
    expect(claims.sort()).toEqual([false, true]);
    expect(await balance(target.organizationId)).toBe(1_950_000n);
  });
});
