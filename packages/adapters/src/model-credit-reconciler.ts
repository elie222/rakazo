import type { AgentUsage, ModelUsageLookup } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { expireModelCredits, hasFinalModelCost, recordUsage, runAsSystem } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";

/** Bounded, leased recovery. Missing evidence is flagged rather than converted into free usage. */
export function createModelCreditReconciler(deps: {
  prisma: PrismaClient;
  lookup?: ModelUsageLookup;
  now?: () => Date;
}) {
  const { prisma, lookup } = deps;
  let balanceCursor: string | undefined;
  let nextBalanceAuditAt = 0;
  return () =>
    runAsSystem("reconcile model usage and credit balances", async () => {
      const now = deps.now?.() ?? new Date();
      const expiring = await prisma.modelCreditLot.findMany({
        where: { expiresAt: { lte: now }, availableMicros: { gt: 0n } },
        select: { organizationId: true },
        take: 25,
      });
      for (const organizationId of new Set(expiring.map((lot) => lot.organizationId)))
        await expireModelCredits(prisma, organizationId, now);
      const calls = await prisma.modelCreditEntry.findMany({
        where: {
          reconciliationState: "pending",
          nextReconcileAt: { lte: now },
          callId: { not: null },
        },
        orderBy: [{ nextReconcileAt: "asc" }, { id: "asc" }],
        take: 5,
      });
      await Promise.all(
        calls.map(async (call) => {
          const claimed = await prisma.modelCreditEntry.updateMany({
            where: {
              id: call.id,
              auditRevision: call.auditRevision,
              reconciliationState: "pending",
            },
            data: {
              nextReconcileAt: new Date(now.getTime() + 120_000),
              reconciliationAttempts: { increment: 1 },
            },
          });
          if (!claimed.count) return;
          let complete = false;
          // Why this attempt could not settle the hold, for whoever reviews it.
          let reason = "usage unavailable";
          try {
            if (!call.callId || !call.userId || !call.spaceId || !call.provider || !call.model)
              throw new Error("Legacy reservation requires manual attribution");
            let usage = call.usage as unknown as AgentUsage | null;
            let reconciled = false;
            if (lookup?.provider === call.provider && call.providerRequestId) {
              const recovered = await lookup.lookupUsage(call.providerRequestId);
              if (recovered) {
                usage = { ...usage, ...recovered };
                reconciled = true;
              } else reason = "provider has no usage for the request";
            }
            if (
              usage &&
              usage.costUsd != null &&
              (call.pending || reconciled || hasFinalModelCost(usage))
            ) {
              await recordUsage(
                prisma,
                {
                  ...usage,
                  type: "usage",
                  provider: call.provider,
                  model: call.model,
                  callId: call.callId,
                },
                {
                  userId: call.userId,
                  spaceId: call.spaceId,
                  runId: call.runId ?? undefined,
                  operationId: call.runId ?? call.callId,
                  operationKind: usage.operationKind ?? "answer",
                },
                true,
              );
              complete = hasFinalModelCost(usage);
              if (!complete) reason = "cost is not final";
            } else if (usage) {
              reason = usage.costUsd == null ? "cost unavailable" : "cost is not final";
            }
          } catch (error) {
            reason = error instanceof Error ? error.message : String(error);
            getLogger().warn("Model credit reconciliation could not verify a call", {
              callId: call.callId,
              reason,
            });
          }
          const needsReview = !complete && call.reconciliationAttempts >= 5;
          await prisma.modelCreditEntry.updateMany({
            where: { id: call.id, reconciliationState: "pending" },
            data: {
              reconciliationState: complete ? "complete" : needsReview ? "needs_review" : "pending",
              nextReconcileAt:
                complete || needsReview
                  ? null
                  : new Date(
                      now.getTime() +
                        Math.min(3_600_000, 30_000 * 2 ** call.reconciliationAttempts),
                    ),
            },
          });
          if (needsReview)
            getLogger().error("Model credit hold requires review", {
              callId: call.callId,
              reason,
              provider: call.provider,
              model: call.model,
              pending: call.pending,
              attempts: call.reconciliationAttempts + 1,
              hasProviderRequestId: Boolean(call.providerRequestId),
              canLookUpUsage: lookup?.provider === call.provider,
            });
        }),
      );
      // Hourly full journal verification, paginated separately from frequent call recovery.
      if (!balanceCursor && now.getTime() < nextBalanceAuditAt) return;
      const accounts = await prisma.modelCreditAccount.findMany({
        where: balanceCursor ? { organizationId: { gt: balanceCursor } } : {},
        orderBy: { organizationId: "asc" },
        take: 25,
        select: { organizationId: true },
      });
      balanceCursor = accounts.length === 25 ? accounts.at(-1)!.organizationId : undefined;
      if (!balanceCursor) nextBalanceAuditAt = now.getTime() + 3_600_000;
      for (let offset = 0; offset < accounts.length; offset += 5)
        await Promise.all(
          accounts.slice(offset, offset + 5).map(({ organizationId }) =>
            prisma.$transaction(async (tx) => {
              await tx.$queryRaw`SELECT "organizationId" FROM model_credit_accounts WHERE "organizationId"=${organizationId} FOR UPDATE`;
              const account = await tx.modelCreditAccount.findUnique({ where: { organizationId } });
              if (!account) return;
              const total = await tx.billingAuditEvent.aggregate({
                where: { organizationId },
                _sum: { amountMicros: true },
              });
              const expected = total._sum.amountMicros ?? 0n;
              if (expected === account.balanceMicros) return;
              await tx.billingAuditEvent.create({
                data: {
                  source: `balance:${organizationId}:${crypto.randomUUID()}`,
                  kind: "balance_rebuilt",
                  organizationId,
                  details: {
                    balanceMicros: account.balanceMicros.toString(),
                    expectedMicros: expected.toString(),
                  },
                },
              });
              await tx.modelCreditAccount.update({
                where: { organizationId },
                data: { balanceMicros: expected },
              });
              getLogger().error("Model credit balance does not match the audit journal", {
                organizationId,
              });
            }),
          ),
        );
    });
}
