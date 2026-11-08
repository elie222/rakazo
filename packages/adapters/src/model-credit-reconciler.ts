import type { AgentUsage, ModelUsageLookup } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import {
  expireModelCredits,
  hasFinalModelCost,
  MICROS_PER_DOLLAR,
  Prisma,
  RECONCILED_ESTIMATE_COST_SOURCE,
  recordUsage,
  runAsSystem,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";

/**
 * When the provider never reports a cost, a call that reached it is charged for the tokens we
 * counted at the model's cheapest rates; one that never reached it is free. Never more than held.
 */
function fallbackUsage(usage: AgentUsage | null, heldMicros: bigint): AgentUsage {
  const rates = usage?.pricingSnapshot;
  const rate = (key: string) => {
    const value = rates?.[key];
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
  };
  const counted = usage?.countedTokens;
  const tokenCost =
    usage?.inputTokens != null || usage?.outputTokens != null
      ? (usage.inputTokens ?? 0) * rate("input") +
        (usage.cacheReadTokens ?? 0) * rate("cacheRead") +
        (usage.cacheWriteTokens ?? 0) * rate("cacheWrite") +
        (usage.outputTokens ?? 0) * rate("output")
      : counted
        ? // A partial prompt may have been served from cache; assume it was.
          counted.inputTokens * (rate("cacheRead") || rate("input")) +
          counted.outputTokens * rate("output")
        : 0;
  const costUsd = Math.min(
    usage?.costUsd ?? tokenCost / 1_000_000,
    Math.max(0, Number(heldMicros)) / MICROS_PER_DOLLAR,
  );
  return {
    inputTokens: null,
    outputTokens: null,
    ...usage,
    costUsd,
    costSource: RECONCILED_ESTIMATE_COST_SOURCE,
  };
}

/** Bounded, leased recovery: provider cost first, then counted tokens, never more than held. */
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
          const lastAttempt = call.reconciliationAttempts >= 5;
          try {
            if (!call.callId || !call.userId || !call.spaceId || !call.provider || !call.model)
              throw new Error("Legacy reservation requires manual attribution");
            let usage = call.usage as unknown as AgentUsage | null;
            let reconciled = false;
            const canLookUp = lookup?.provider === call.provider && !!call.providerRequestId;
            if (canLookUp) {
              try {
                const recovered = await lookup.lookupUsage(call.providerRequestId!);
                if (recovered) {
                  usage = { ...usage, ...recovered };
                  reconciled = true;
                } else reason = "provider has no usage for the request";
              } catch (error) {
                // The last attempt falls back to counted tokens rather than holding the estimate.
                if (!lastAttempt) throw error;
                reason = error instanceof Error ? error.message : String(error);
              }
            }
            // Without a receipt the call may still be running, so only the last attempt settles it.
            if (!(usage && hasFinalModelCost(usage)) && (lastAttempt || (usage && !canLookUp))) {
              usage = fallbackUsage(usage, -call.amountMicros);
              reconciled = true;
              getLogger().info("Model credit hold settled without a provider cost", {
                callId: call.callId,
                reason,
                costUsd: usage.costUsd,
                hasProviderRequestId: Boolean(call.providerRequestId),
                counted: Boolean(usage.countedTokens),
              });
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
      // One read checks the page; only accounts that disagree are locked and rebuilt.
      const drifted = accounts.length
        ? await prisma.$queryRaw<Array<{ organizationId: string }>>`
            SELECT a."organizationId" FROM model_credit_accounts a
            WHERE a."organizationId" IN (${Prisma.join(accounts.map((account) => account.organizationId))})
              AND a."balanceMicros" <> COALESCE((
                SELECT SUM(e."amountMicros") FROM billing_audit_events e
                WHERE e."organizationId" = a."organizationId"
              ), 0)`
        : [];
      for (let offset = 0; offset < drifted.length; offset += 5)
        await Promise.all(
          drifted.slice(offset, offset + 5).map(({ organizationId }) =>
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
