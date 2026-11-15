import type { BillingPlanPayment, BillingProvider, PartnerProgram } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { isOwnerRole } from "@rakazo/db";
import { bestEffort, getLogger } from "@rakazo/logging";

/** A founding owner joins as signup creates the organization; anyone later did not create it. */
const FOUNDING_WINDOW_MS = 60_000;
/** How long after reporting a sale the program may still be creating its earnings. */
const EARNINGS_SETTLE_MS = 86_400_000;

/**
 * Reports a customer's own-key plan payments to the partner program when the organization was
 * created by an account that signed up from a partner's link, and withdraws those later refunded or
 * lost to a dispute, even once the organization is gone. Credits never count.
 *
 * Reporting a sale is best effort. Withdrawing one is not: `report` rejects when any withdrawal
 * failed, so the caller can have the payment provider deliver the event again.
 */
export function createPartnerSales(deps: {
  prisma: PrismaClient;
  provider: Pick<BillingProvider, "listPlanPayments">;
  program?: PartnerProgram;
}) {
  const { prisma, provider, program } = deps;

  return {
    /** `organizationId` is null when the customer's organization was deleted. */
    async report(customerId: string, organizationId: string | null): Promise<void> {
      if (!program || !provider.listPlanPayments) return;
      const organization = organizationId
        ? await prisma.organization.findUnique({
            where: { id: organizationId },
            select: {
              createdAt: true,
              members: {
                where: { user: { signupPartnerClickId: { not: null } } },
                select: { userId: true, role: true, createdAt: true },
              },
            },
          })
        : null;
      const founder = organization?.members.find(
        (member) =>
          isOwnerRole(member.role) &&
          member.createdAt.getTime() - organization.createdAt.getTime() < FOUNDING_WINDOW_MS,
      );
      const open = await prisma.partnerSale.findMany({
        where: { customerId, refundedAt: null },
        select: { invoiceId: true, invoiceCreatedAt: true, createdAt: true },
      });
      const since = Math.min(
        founder && organization ? organization.createdAt.getTime() : Number.POSITIVE_INFINITY,
        ...open.map((sale) => sale.invoiceCreatedAt.getTime()),
      );
      if (!Number.isFinite(since)) return;
      const payments = await provider.listPlanPayments(customerId, new Date(since));
      const openInvoices = new Map(open.map((sale) => [sale.invoiceId, sale]));

      // Withdrawals first, each on its own, so no failing report can hold one back.
      const failed: unknown[] = [];
      for (const payment of payments) {
        const sale = openInvoices.get(payment.invoiceId);
        if (!sale || !payment.reversed) continue;
        try {
          const outcome = await program.refundSale(payment.invoiceId);
          if (outcome === "not_found" && Date.now() - sale.createdAt.getTime() < EARNINGS_SETTLE_MS)
            throw new Error(`Partner earnings for ${payment.invoiceId} are not created yet`);
          if (outcome === "already_paid")
            getLogger().error("partner commission was paid out before its refund; recover it", {
              "billing.invoice_id": payment.invoiceId,
            });
          await prisma.partnerSale.update({
            where: { invoiceId: payment.invoiceId },
            data: { refundedAt: new Date() },
          });
        } catch (error) {
          failed.push(error);
        }
      }
      if (founder) await reportSales(customerId, founder.userId, payments, openInvoices);
      if (failed.length)
        throw new AggregateError(failed, "Partner program withdrawals failed; retry the event");
    },
  };

  async function reportSales(
    customerId: string,
    userId: string,
    payments: BillingPlanPayment[],
    recorded: Map<string, unknown>,
  ): Promise<void> {
    if (!program) return;
    for (const payment of payments) {
      // A withdrawn sale's invoice stays reversed, so it is never reported again.
      if (recorded.has(payment.invoiceId) || payment.reversed || payment.amountCents <= 0) continue;
      await bestEffort(
        `partner program sale ${payment.invoiceId}`,
        program
          .trackSale({
            customerId: userId,
            invoiceId: payment.invoiceId,
            amountCents: payment.amountCents,
            currency: payment.currency,
          })
          // The program records each invoice once, so a concurrent sync reporting it too is harmless.
          .then(() =>
            prisma.partnerSale.createMany({
              data: {
                invoiceId: payment.invoiceId,
                customerId,
                invoiceCreatedAt: payment.createdAt,
              },
              skipDuplicates: true,
            }),
          ),
      );
    }
  }
}
