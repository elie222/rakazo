import type { BillingPlanPayment, PartnerProgram } from "@rakazo/adapter-kit";
import { BillingCustomerNotFoundError } from "@rakazo/adapter-kit";
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

  async function organization(
    name: string,
    partnerClickId: string | null,
    { role = "owner", joinedAfterMs = 0 } = {},
  ) {
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
      data: {
        id,
        organizationId: id,
        userId: id,
        role,
        createdAt: new Date(createdAt.getTime() + joinedAfterMs),
      },
    });
    ids.push(id);
    return id;
  }

  function fakeProgram() {
    return {
      trackSignup: vi.fn(async () => {}),
      trackSale: vi.fn(async (_sale: Parameters<PartnerProgram["trackSale"]>[0]) => {}),
      refundSale: vi.fn(
        async (_invoiceId: string): ReturnType<PartnerProgram["refundSale"]> => "withdrawn",
      ),
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

  it("credits a founder holding other roles too, but not a referred owner who joined later", async () => {
    const program = fakeProgram();
    const founded = await organization("founder", "click_5", { role: "admin, owner" });
    const joined = await organization("promoted", "click_8", { joinedAfterMs: 5 * 60_000 });
    const payment = paid("in_founder");
    const sales = createPartnerSales({
      prisma,
      program,
      provider: { listPlanPayments: async () => [payment] },
    });
    await sales.report("cus_founder", founded);
    await sales.report("cus_promoted", joined);
    expect(program.trackSale).toHaveBeenCalledTimes(1);
    expect(program.trackSale).toHaveBeenCalledWith(
      expect.objectContaining({ customerId: founded, invoiceId: payment.invoiceId }),
    );
  });

  it("retries a withdrawal until the program has the earnings to withdraw", async () => {
    const organizationId = await organization("early-refund", "click_9");
    const program = fakeProgram();
    let payments = [paid("in_early_refund")];
    const sales = createPartnerSales({
      prisma,
      program,
      provider: { listPlanPayments: async () => payments },
    });
    await sales.report("cus_early_refund", organizationId);
    payments = payments.map((payment) => ({ ...payment, reversed: true }));
    program.refundSale.mockResolvedValueOnce("not_found");
    await expect(sales.report("cus_early_refund", organizationId)).rejects.toThrow(
      "withdrawals failed",
    );
    await sales.report("cus_early_refund", organizationId);
    await sales.report("cus_early_refund", organizationId);
    expect(program.refundSale).toHaveBeenCalledTimes(2);
  });

  it("fails the run when a withdrawal fails, but still reports other payments", async () => {
    const organizationId = await organization("withdrawal-down", "click_10");
    const program = fakeProgram();
    let payments = [paid("in_to_refund")];
    const sales = createPartnerSales({
      prisma,
      program,
      provider: { listPlanPayments: async () => payments },
    });
    await sales.report("cus_withdrawal_down", organizationId);
    const renewal = paid("in_renewal_meanwhile");
    payments = [{ ...payments[0]!, reversed: true }, renewal];
    program.refundSale.mockRejectedValueOnce(new Error("unavailable"));
    await expect(sales.report("cus_withdrawal_down", organizationId)).rejects.toThrow(
      "withdrawals failed",
    );
    expect(program.trackSale).toHaveBeenLastCalledWith(
      expect.objectContaining({ invoiceId: renewal.invoiceId }),
    );
  });

  it("stops withdrawing a payout already made, leaving it to be recovered by hand", async () => {
    const organizationId = await organization("paid-out", "click_11");
    const program = fakeProgram();
    let payments = [paid("in_paid_out")];
    const sales = createPartnerSales({
      prisma,
      program,
      provider: { listPlanPayments: async () => payments },
    });
    await sales.report("cus_paid_out", organizationId);
    payments = payments.map((payment) => ({ ...payment, reversed: true }));
    program.refundSale.mockResolvedValueOnce("already_paid");
    await sales.report("cus_paid_out", organizationId);
    await sales.report("cus_paid_out", organizationId);
    expect(program.refundSale).toHaveBeenCalledTimes(1);
  });

  it("withdraws a sale whose confirmation was lost once its payment is refunded", async () => {
    const organizationId = await organization("unconfirmed", "click_12");
    const program = fakeProgram();
    let payments = [paid("in_unconfirmed")];
    const sales = createPartnerSales({
      prisma,
      program,
      provider: { listPlanPayments: async () => payments },
    });
    program.trackSale.mockRejectedValueOnce(new Error("timed out after the program took it"));
    await sales.report("cus_unconfirmed", organizationId);
    payments = payments.map((payment) => ({ ...payment, reversed: true }));
    await sales.report("cus_unconfirmed", organizationId);
    expect(program.refundSale).toHaveBeenCalledWith(payments[0]!.invoiceId);
  });

  it("keeps looking for earnings that are still missing a day after the sale", async () => {
    const organizationId = await organization("missing-earnings", "click_13");
    const program = fakeProgram();
    let payments = [paid("in_missing_earnings")];
    const sales = createPartnerSales({
      prisma,
      program,
      provider: { listPlanPayments: async () => payments },
    });
    await sales.report("cus_missing_earnings", organizationId);
    await prisma.partnerSale.update({
      where: { invoiceId: payments[0]!.invoiceId },
      data: {
        createdAt: new Date(Date.now() - 2 * 86_400_000),
        reportedAt: new Date(Date.now() - 2 * 86_400_000),
      },
    });
    payments = payments.map((payment) => ({ ...payment, reversed: true }));
    program.refundSale.mockResolvedValueOnce("not_found");
    await sales.report("cus_missing_earnings", organizationId);
    await sales.report("cus_missing_earnings", organizationId);
    expect(program.refundSale).toHaveBeenCalledTimes(2);
  });

  it("keeps looking for earnings of a refunded sale the program never confirmed", async () => {
    const organizationId = await organization("never-confirmed", "click_15");
    const program = fakeProgram();
    let payments = [paid("in_never_confirmed")];
    const sales = createPartnerSales({
      prisma,
      program,
      provider: { listPlanPayments: async () => payments },
    });
    program.trackSale.mockRejectedValueOnce(new Error("program down"));
    await sales.report("cus_never_confirmed", organizationId);
    await prisma.partnerSale.update({
      where: { invoiceId: payments[0]!.invoiceId },
      data: { createdAt: new Date(Date.now() - 2 * 86_400_000) },
    });
    payments = payments.map((payment) => ({ ...payment, reversed: true }));
    program.refundSale.mockResolvedValue("not_found");
    await sales.report("cus_never_confirmed", organizationId);
    await sales.report("cus_never_confirmed", organizationId);
    expect(program.refundSale).toHaveBeenCalledTimes(2);
  });

  it("does not send a sale a refund already recorded as withdrawn", async () => {
    const organizationId = await organization("refunded-first", "click_16");
    const program = fakeProgram();
    const payment = paid("in_refunded_first");
    await createPartnerSales({
      prisma,
      program,
      provider: { listPlanPayments: async () => [{ ...payment, reversed: true }] },
    }).report("cus_refunded_first", organizationId);
    await createPartnerSales({
      prisma,
      program,
      provider: { listPlanPayments: async () => [payment] },
    }).report("cus_refunded_first", organizationId);
    expect(program.trackSale).not.toHaveBeenCalled();
  });

  it("withdraws a sale refunded while it was being sent", async () => {
    const organizationId = await organization("refund-first", "click_17");
    const program = fakeProgram();
    const payment = paid("in_refund_first");
    const reporting = createPartnerSales({
      prisma,
      program,
      provider: { listPlanPayments: async () => [payment] },
    });
    const refunding = createPartnerSales({
      prisma,
      program,
      provider: { listPlanPayments: async () => [{ ...payment, reversed: true }] },
    });
    program.trackSale.mockImplementationOnce(async () => {
      await refunding.report("cus_refund_first", organizationId);
    });
    await reporting.report("cus_refund_first", organizationId);
    expect(program.refundSale).toHaveBeenCalledWith(payment.invoiceId);
  });

  it("keeps a sale the program took but did not acknowledge open for withdrawal", async () => {
    const organizationId = await organization("unacknowledged", "click_18");
    const program = fakeProgram();
    let payments = [paid("in_unacknowledged")];
    const sales = createPartnerSales({
      prisma,
      program,
      provider: { listPlanPayments: async () => payments },
    });
    program.trackSale.mockRejectedValueOnce(new Error("acknowledgement lost"));
    await sales.report("cus_unacknowledged", organizationId);
    payments = payments.map((payment) => ({ ...payment, reversed: true }));
    await sales.report("cus_unacknowledged", organizationId);
    expect(program.refundSale).toHaveBeenCalledWith(payments[0]!.invoiceId);
  });

  it("has nothing to do for a billing customer that no longer exists", async () => {
    const organizationId = await organization("gone", "click_14");
    await expect(
      createPartnerSales({
        prisma,
        program: fakeProgram(),
        provider: {
          listPlanPayments: async () => {
            throw new BillingCustomerNotFoundError();
          },
        },
      }).report("cus_gone", organizationId),
    ).resolves.toBeUndefined();
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
    await prisma.organization.delete({ where: { id: organizationId } });

    payments = payments.map((payment) => ({ ...payment, reversed: true }));
    await sales.report("cus_late_paid", null);
    expect(listPlanPayments.mock.calls[1]![1]).toEqual(createdAt);
    expect(program.refundSale).toHaveBeenCalledWith(payments[0]!.invoiceId);
  });
});
