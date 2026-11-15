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

  async function organization(name: string, partnerClickId: string | null, role = "owner") {
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
      data: { id, organizationId: id, userId: id, role, createdAt },
    });
    ids.push(id);
    return id;
  }

  function fakeProgram() {
    return {
      trackSignup: vi.fn(async () => {}),
      trackSale: vi.fn(async (_sale: Parameters<PartnerProgram["trackSale"]>[0]) => {}),
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
      createdAt: extra.createdAt ?? new Date(),
      paidAt: extra.paidAt ?? new Date(Date.now() + 1000),
    };
  }

  beforeAll(async () => {
    db = createDb(process.env.DATABASE_URL!);
    prisma = asSystem(db.prisma);
  });

  afterAll(async () => {
    await prisma.partnerSale.deleteMany({ where: { invoiceId: { endsWith: stamp } } });
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
    await sales.report("cus_referred", organizationId);
    await sales.report("cus_referred", organizationId);
    expect(program.trackSale).toHaveBeenCalledTimes(1);
    expect(program.trackSale).toHaveBeenCalledWith({
      customerId: organizationId,
      invoiceId: payments[0]!.invoiceId,
      amountCents: 1500,
      currency: "usd",
    });

    payments.push(paid("in_renewal"));
    await sales.report("cus_referred", organizationId);
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
    await sales.report("cus_refunded", organizationId);
    expect(program.trackSale).toHaveBeenCalledTimes(1);

    payments = payments.map((payment) => ({ ...payment, reversed: true }));
    await sales.report("cus_refunded", organizationId);
    await sales.report("cus_refunded", organizationId);
    expect(program.refundSale).toHaveBeenCalledTimes(1);
    expect(program.refundSale).toHaveBeenCalledWith(payments[0]!.invoiceId);
  });

  it("withdraws a commission refunded after its organization was deleted", async () => {
    const organizationId = await organization("deleted", "click_4");
    const program = fakeProgram();
    let payments = [paid("in_before_deletion")];
    const sales = createPartnerSales({
      prisma,
      program,
      provider: { listPlanPayments: async () => payments },
    });
    await sales.report("cus_deleted", organizationId);
    await prisma.organization.delete({ where: { id: organizationId } });

    payments = payments.map((payment) => ({ ...payment, reversed: true }));
    await sales.report("cus_deleted", null);
    expect(program.refundSale).toHaveBeenCalledWith(payments[0]!.invoiceId);
  });

  it("credits an owner holding other roles too, but not payments from before they joined", async () => {
    const organizationId = await organization("co-owner", "click_5", "admin, owner");
    const program = fakeProgram();
    const before = paid("in_before_joining", { paidAt: new Date(Date.now() - 86_400_000) });
    const after = paid("in_after_joining");
    await createPartnerSales({
      prisma,
      program,
      provider: { listPlanPayments: async () => [before, after] },
    }).report("cus_co_owner", organizationId);
    expect(program.trackSale).toHaveBeenCalledTimes(1);
    expect(program.trackSale).toHaveBeenCalledWith(
      expect.objectContaining({ invoiceId: after.invoiceId }),
    );
  });

  it("leaves organizations whose owner did not come from a partner alone", async () => {
    const organizationId = await organization("direct", null);
    const program = fakeProgram();
    const listPlanPayments = vi.fn(async () => [paid("in_direct")]);
    await createPartnerSales({ prisma, program, provider: { listPlanPayments } }).report(
      "cus_direct",
      organizationId,
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
    await sales.report("cus_retried", organizationId);
    await sales.report("cus_retried", organizationId);
    expect(program.trackSale).toHaveBeenCalledTimes(2);
  });

  it("withdraws refunds even while the program keeps refusing another payment", async () => {
    const organizationId = await organization("stuck", "click_6");
    const program = fakeProgram();
    let payments = [paid("in_refused"), paid("in_kept_stuck")];
    const sales = createPartnerSales({
      prisma,
      program,
      provider: { listPlanPayments: async () => payments },
    });
    program.trackSale.mockImplementation(async ({ invoiceId }) => {
      if (invoiceId === payments[0]!.invoiceId) throw new Error("refused");
    });
    await sales.report("cus_stuck", organizationId);
    payments = [payments[0]!, { ...payments[1]!, reversed: true }];
    await sales.report("cus_stuck", organizationId);
    expect(program.refundSale).toHaveBeenCalledWith(payments[1]!.invoiceId);
  });

  it("reads back to an invoice created long before a refund that comes after deletion", async () => {
    const organizationId = await organization("late-paid", "click_7");
    const program = fakeProgram();
    const createdAt = new Date(Date.now() - 90 * 86_400_000);
    let payments = [paid("in_late_paid", { createdAt })];
    const listPlanPayments = vi.fn(async (_customerId: string, _since: Date) => payments);
    const sales = createPartnerSales({ prisma, program, provider: { listPlanPayments } });
    await sales.report("cus_late_paid", organizationId);
    expect(listPlanPayments.mock.calls[0]![1].getTime()).toBeLessThan(Date.now() - 34 * 86_400_000);
    await prisma.organization.delete({ where: { id: organizationId } });

    payments = payments.map((payment) => ({ ...payment, reversed: true }));
    await sales.report("cus_late_paid", null);
    expect(listPlanPayments.mock.calls[1]![1]).toEqual(createdAt);
    expect(program.refundSale).toHaveBeenCalledWith(payments[0]!.invoiceId);
  });
});
