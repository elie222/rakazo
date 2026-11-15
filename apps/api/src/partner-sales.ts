import type { BillingProvider, PartnerProgram } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { isOwnerRole } from "@rakazo/db";
import { bestEffort } from "@rakazo/logging";

/** How long before its payment a plan invoice can be created, as failed payments are retried. */
const INVOICE_TO_PAYMENT_MS = 35 * 86_400_000;

/**
 * Reports a customer's own-key plan payments to the partner program when the organization's owner
 * signed up from a partner's link, and withdraws those later refunded or disputed, even once the
 * organization is gone. Credits never count, nor payments made before that owner joined.
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
      const owner = organizationId
        ? (
            await prisma.member.findMany({
              where: { organizationId, user: { signupPartnerClickId: { not: null } } },
              select: { userId: true, role: true, createdAt: true },
              orderBy: { createdAt: "asc" },
            })
          ).find((member) => isOwnerRole(member.role))
        : undefined;
      const open = await prisma.partnerSale.findMany({
        where: { customerId, refundedAt: null },
        select: { invoiceId: true, invoiceCreatedAt: true },
      });
      const since = Math.min(
        owner ? owner.createdAt.getTime() - INVOICE_TO_PAYMENT_MS : Number.POSITIVE_INFINITY,
        ...open.map((sale) => sale.invoiceCreatedAt.getTime()),
      );
      if (!Number.isFinite(since)) return;
      const payments = await provider.listPlanPayments(customerId, new Date(since));
      const openInvoices = new Set(open.map((sale) => sale.invoiceId));

      // Withdrawals first, each on its own, so no failing report can hold one back.
      for (const payment of payments) {
        if (!openInvoices.has(payment.invoiceId) || !payment.reversed) continue;
        await bestEffort(
          `partner program refund ${payment.invoiceId}`,
          program.refundSale(payment.invoiceId).then(() =>
            prisma.partnerSale.update({
              where: { invoiceId: payment.invoiceId },
              data: { refundedAt: new Date() },
            }),
          ),
        );
      }
      if (!owner) return;
      for (const payment of payments) {
        // A withdrawn sale's invoice stays reversed, so it is never reported again.
        if (
          openInvoices.has(payment.invoiceId) ||
          payment.reversed ||
          payment.amountCents <= 0 ||
          payment.paidAt < owner.createdAt
        )
          continue;
        await bestEffort(
          `partner program sale ${payment.invoiceId}`,
          program
            .trackSale({
              customerId: owner.userId,
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
    },
  };
}
