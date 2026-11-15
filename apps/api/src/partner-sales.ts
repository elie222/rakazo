import type { BillingProvider, PartnerProgram } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";

/**
 * Reports a customer's own-key plan payments to the partner program when the organization's owner
 * signed up from a partner's link, and withdraws those later refunded or disputed, even once the
 * organization is gone. Credits never count.
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
        ? await prisma.member.findFirst({
            where: { organizationId, role: "owner", user: { signupPartnerClickId: { not: null } } },
            select: { userId: true },
          })
        : null;
      const recorded = new Map(
        (
          await prisma.partnerSale.findMany({
            where: { customerId },
            select: { invoiceId: true, refundedAt: true },
          })
        ).map((sale) => [sale.invoiceId, sale]),
      );
      if (!owner && ![...recorded.values()].some((sale) => !sale.refundedAt)) return;
      for (const payment of await provider.listPlanPayments(customerId)) {
        const sale = recorded.get(payment.invoiceId);
        if (!sale) {
          if (!owner || payment.reversed || payment.amountCents <= 0) continue;
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
        } else if (payment.reversed && !sale.refundedAt) {
          await program.refundSale(payment.invoiceId);
          await prisma.partnerSale.update({
            where: { invoiceId: payment.invoiceId },
            data: { refundedAt: new Date() },
          });
        }
      }
    },
  };
}
