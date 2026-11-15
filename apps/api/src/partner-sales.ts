import type { BillingProvider, PartnerProgram } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { isOwnerRole } from "@rakazo/db";
import { bestEffort } from "@rakazo/logging";

/** A founding owner joins as signup creates the organization; anyone later did not create it. */
const FOUNDING_WINDOW_MS = 60_000;

/**
 * Reports a customer's own-key plan payments to the partner program when the organization was
 * created by an account that signed up from a partner's link, and withdraws those later refunded or
 * lost to a dispute, even once the organization is gone. Credits never count.
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
        select: { invoiceId: true, invoiceCreatedAt: true },
      });
      const since = Math.min(
        founder && organization ? organization.createdAt.getTime() : Number.POSITIVE_INFINITY,
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
      if (!founder) return;
      for (const payment of payments) {
        // A withdrawn sale's invoice stays reversed, so it is never reported again.
        if (openInvoices.has(payment.invoiceId) || payment.reversed || payment.amountCents <= 0)
          continue;
        await bestEffort(
          `partner program sale ${payment.invoiceId}`,
          program
            .trackSale({
              customerId: founder.userId,
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
