import type { BillingPlanPayment, PartnerProgram } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { asSystem, createDb } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createPartnerSales } from "./partner-sales.js";

const dbTests = process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe : describe.skip;
dbTests("partner program sales", () => {
  const stamp = `${process.pid}-${Date.now()}`;
  const ids: string[] = [];
  let prisma: PrismaClient;
  let db: ReturnType<typeof createDb>;

  async function organization(name: string, partnerClickId: string | null) {
    const id = `partner-${name}-${stamp}`;
    const createdAt = new Date();
    await prisma.user.create({
      data: {
        id,
        name,
        email: `${id}@rakazo.test`,
        emailVerified: true,
        signupPartnerClickId: partnerClickId,
      },
    });
    await prisma.organization.create({ data: { id, name, slug: id, createdAt } });
    await prisma.member.create({
      data: { id, organizationId: id, userId: id, role: "owner", createdAt },
    });
    ids.push(id);
    return id;
  }

  function fakeProgram() {
    return {
      trackSignup: vi.fn(async () => {}),
      trackSale: vi.fn(async () => {}),
      refundSale: vi.fn(async () => {}),
    } satisfies PartnerProgram;
  }

  function paid(invoiceId: string, extra: Partial<BillingPlanPayment> = {}): BillingPlanPayment {
    return {
      invoiceId: `${invoiceId}-${stamp}`,
      amountCents: 1500,
      currency: "usd",
      reversed: false,
      ...extra,
    };
  }

  beforeAll(async () => {
    db = createDb(process.env.DATABASE_URL!);
    prisma = asSystem(db.prisma);
  });

  afterAll(async () => {
    await prisma.organization.deleteMany({ where: { id: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
    await db.prisma.$disconnect();
    await db.pool.end();
  });

  it("reports each plan payment of a referred owner's organization once", async () => {
    const organizationId = await organization("referred", "click_1");
    const program = fakeProgram();
    const payments = [paid("in_first"), paid("in_trial", { amountCents: 0 })];
    const sales = createPartnerSales({
      prisma,
      program,
      provider: { listPlanPayments: async () => payments },
    });
    await sales.report(organizationId, "cus_referred");
    await sales.report(organizationId, "cus_referred");
    expect(program.trackSale).toHaveBeenCalledTimes(1);
    expect(program.trackSale).toHaveBeenCalledWith({
      customerId: organizationId,
      invoiceId: payments[0]!.invoiceId,
      amountCents: 1500,
      currency: "usd",
    });

    payments.push(paid("in_renewal"));
    await sales.report(organizationId, "cus_referred");
    expect(program.trackSale).toHaveBeenCalledTimes(2);
  });

  it("withdraws a reported payment once it is refunded, and never reports one already reversed", async () => {
    const organizationId = await organization("refunded", "click_2");
    const program = fakeProgram();
    let payments = [paid("in_kept"), paid("in_reversed_early", { reversed: true })];
    const sales = createPartnerSales({
      prisma,
      program,
      provider: { listPlanPayments: async () => payments },
    });
    await sales.report(organizationId, "cus_refunded");
    expect(program.trackSale).toHaveBeenCalledTimes(1);

    payments = payments.map((payment) => ({ ...payment, reversed: true }));
    await sales.report(organizationId, "cus_refunded");
    await sales.report(organizationId, "cus_refunded");
    expect(program.refundSale).toHaveBeenCalledTimes(1);
    expect(program.refundSale).toHaveBeenCalledWith(payments[0]!.invoiceId);
  });

  it("leaves organizations whose owner did not come from a partner alone", async () => {
    const organizationId = await organization("direct", null);
    const program = fakeProgram();
    const listPlanPayments = vi.fn(async () => [paid("in_direct")]);
    await createPartnerSales({ prisma, program, provider: { listPlanPayments } }).report(
      organizationId,
      "cus_direct",
    );
    expect(listPlanPayments).not.toHaveBeenCalled();
    expect(program.trackSale).not.toHaveBeenCalled();
  });

  it("tries a payment again on the next sync when the program refused it", async () => {
    const organizationId = await organization("retried", "click_3");
    const program = fakeProgram();
    program.trackSale.mockRejectedValueOnce(new Error("unavailable"));
    const sales = createPartnerSales({
      prisma,
      program,
      provider: { listPlanPayments: async () => [paid("in_retried")] },
    });
    await expect(sales.report(organizationId, "cus_retried")).rejects.toThrow("unavailable");
    await sales.report(organizationId, "cus_retried");
    expect(program.trackSale).toHaveBeenCalledTimes(2);
  });
});
