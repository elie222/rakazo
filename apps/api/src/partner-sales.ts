import type { BillingProvider, PartnerProgram } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";

/**
 * Reports an organization's own-key plan payments to the partner program when its owner signed up
 * from a partner's link, and withdraws those later refunded or disputed. Credits never count.
 */
export function createPartnerSales(deps: {
  prisma: PrismaClient;
  provider: Pick<BillingProvider, "listPlanPayments">;
  program?: PartnerProgram;
}) {
  const { prisma, provider, program } = deps;

  return {
    async report(organizationId: string, customerId: string): Promise<void> {
      if (!program || !provider.listPlanPayments) return;
      const owner = await prisma.member.findFirst({
        where: { organizationId, role: "owner", user: { signupPartnerClickId: { not: null } } },
        select: { userId: true },
      });
      if (!owner) return;
      const recorded = new Map(
        (
          await prisma.partnerSale.findMany({
            where: { organizationId },
            select: { invoiceId: true, refundedAt: true },
          })
        ).map((sale) => [sale.invoiceId, sale]),
      );
      for (const payment of await provider.listPlanPayments(customerId)) {
        const sale = recorded.get(payment.invoiceId);
        if (!sale) {
          if (payment.reversed || payment.amountCents <= 0) continue;
          await program.trackSale({
            customerId: owner.userId,
            invoiceId: payment.invoiceId,
            amountCents: payment.amountCents,
            currency: payment.currency,
          });
          // The program records each invoice once, so a concurrent sync reporting it too is harmless.
          await prisma.partnerSale.createMany({
            data: { invoiceId: payment.invoiceId, organizationId },
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
