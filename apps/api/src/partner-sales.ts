import type { BillingProvider, PartnerProgram } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { isOwnerRole } from "@rakazo/db";

/** How long before its payment a plan invoice can be created, as failed payments are retried. */
const INVOICE_TO_PAYMENT_DAYS = 35;

/**
 * Reports a customer's own-key plan payments to the partner program when the organization's owner
 * signed up from a partner's link, and withdraws those later refunded or disputed, even once the
 * organization is gone. Credits never count, nor payments from before that owner joined.
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
        select: { invoiceId: true, createdAt: true },
        orderBy: { createdAt: "asc" },
      });
      const firstOpen = open[0]?.createdAt;
      const since = owner?.createdAt ?? firstOpen;
      if (!since) return;
      const openInvoices = new Set(open.map((sale) => sale.invoiceId));
      const payments = await provider.listPlanPayments(
        customerId,
        new Date(
          Math.min(
            since.getTime(),
            (firstOpen?.getTime() ?? Number.POSITIVE_INFINITY) -
              INVOICE_TO_PAYMENT_DAYS * 86_400_000,
          ),
        ),
      );
      for (const payment of payments) {
        // A withdrawn sale's invoice stays reversed, so it is neither withdrawn nor reported again.
        if (openInvoices.has(payment.invoiceId)) {
          if (!payment.reversed) continue;
          await program.refundSale(payment.invoiceId);
          await prisma.partnerSale.update({
            where: { invoiceId: payment.invoiceId },
            data: { refundedAt: new Date() },
          });
          continue;
        }
        if (
          !owner ||
          payment.reversed ||
          payment.amountCents <= 0 ||
          payment.paidAt < owner.createdAt
        )
          continue;
        await program.trackSale({
          customerId: owner.userId,
          invoiceId: payment.invoiceId,
          amountCents: payment.amountCents,
          currency: payment.currency,
        });
        // The program records each invoice once, so a concurrent sync reporting it too is harmless.
        await prisma.partnerSale.createMany({
          data: { invoiceId: payment.invoiceId, customerId },
          skipDuplicates: true,
        });
      }
    },
  };
}
