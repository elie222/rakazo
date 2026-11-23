import type { BillingPlanPayment, BillingProvider, PartnerProgram } from "@rakazo/adapter-kit";
import { BillingCustomerNotFoundError } from "@rakazo/adapter-kit";
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
        select: { invoiceId: true, invoiceCreatedAt: true, createdAt: true, reportedAt: true },
      });
      const since = Math.min(
        founder && organization ? organization.createdAt.getTime() : Number.POSITIVE_INFINITY,
        ...open.map((sale) => sale.invoiceCreatedAt.getTime()),
      );
      if (!Number.isFinite(since)) return;
      let payments: BillingPlanPayment[];
      try {
        payments = await provider.listPlanPayments(customerId, new Date(since));
      } catch (error) {
        // A deleted billing customer takes no more payments or refunds.
        if (error instanceof BillingCustomerNotFoundError) return;
        throw error;
      }
      const openInvoices = new Map(open.map((sale) => [sale.invoiceId, sale]));

      // Withdrawals first, each on its own, so no failing report can hold one back.
      const failed: unknown[] = [];
      if (founder) {
        // A reversed payment with no sale may be about to be reported by another event: recording
        // it as withdrawn stops that report from sending it.
        const unrecorded = payments.filter(
          (payment) => payment.reversed && !openInvoices.has(payment.invoiceId),
        );
        if (unrecorded.length)
          await prisma.partnerSale.createMany({
            data: unrecorded.map((payment) => ({
              invoiceId: payment.invoiceId,
              customerId,
              invoiceCreatedAt: payment.createdAt,
              refundedAt: new Date(),
            })),
            skipDuplicates: true,
          });
      }
      for (const payment of payments) {
        const sale = openInvoices.get(payment.invoiceId);
        if (!sale || !payment.reversed) continue;
        try {
          const outcome = await program.refundSale(payment.invoiceId);
          // The earnings may still appear, so the sale stays open and every later event looks
          // again; only the first day retries the event itself.
          if (outcome === "not_found") {
            if (Date.now() - (sale.reportedAt ?? sale.createdAt).getTime() < EARNINGS_SETTLE_MS)
              throw new Error(`Partner earnings for ${payment.invoiceId} are not created yet`);
            // Even an unconfirmed send may still create earnings, so the sale stays open and every
            // later event for the customer looks again.
            getLogger().warn("partner earnings to withdraw not found yet", {
              "billing.invoice_id": payment.invoiceId,
            });
            continue;
          }
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
    recorded: Map<string, { reportedAt: Date | null }>,
  ): Promise<void> {
    if (!program) return;
    for (const payment of payments) {
      // A withdrawn sale's invoice stays reversed, so it is never reported again.
      if (payment.reversed || payment.amountCents <= 0) continue;
      if (recorded.get(payment.invoiceId)?.reportedAt) continue;
      await bestEffort(
        `partner program sale ${payment.invoiceId}`,
        (async () => {
          await prisma.partnerSale.createMany({
            data: {
              invoiceId: payment.invoiceId,
              customerId,
              invoiceCreatedAt: payment.createdAt,
            },
            skipDuplicates: true,
          });
          // Marked sent before sending, and only while not refunded: a refund that comes after
          // then always finds it to withdraw, and one that came first stops the send.
          const claimed = await prisma.partnerSale.updateMany({
            where: { invoiceId: payment.invoiceId, refundedAt: null, reportedAt: null },
            data: { reportedAt: new Date() },
          });
          if (!claimed.count) return;
          try {
            // The program records each invoice once, so sending it again is harmless.
            await program.trackSale({
              customerId: userId,
              invoiceId: payment.invoiceId,
              amountCents: payment.amountCents,
              currency: payment.currency,
            });
          } catch (error) {
            // Sent again by the next event; a refund meanwhile still finds it open to withdraw.
            await prisma.partnerSale.updateMany({
              where: { invoiceId: payment.invoiceId, refundedAt: null },
              data: { reportedAt: null },
            });
            throw error;
          }
        })(),
      );
    }
  }
}
