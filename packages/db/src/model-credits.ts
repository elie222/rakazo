import { randomUUID } from "node:crypto";
import type { AgentUsage, BillingCreditPurchase } from "@rakazo/adapter-kit";
import type { PrismaClient } from "./client.js";
import { Prisma } from "./generated/prisma/client.js";
import type { CreditAllocation } from "./model-credit-lots.js";
import {
  allocateCreditLots,
  allocatedMicros,
  expireCreditLots,
  prepareCreditLots,
  resizeCreditLot,
  returnCreditLots,
  syncLotBalance,
} from "./model-credit-lots.js";

export const MICROS_PER_DOLLAR = 1_000_000;

export async function creditAccount(prisma: PrismaClient, organizationId: string) {
  try {
    return await prisma.modelCreditAccount.upsert({
      where: { organizationId },
      create: { organizationId },
      update: {},
    });
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002"))
      throw error;
    // Empty-update upserts can race; the organization primary key is the only unique constraint.
    return prisma.modelCreditAccount.findUniqueOrThrow({ where: { organizationId } });
  }
}

/** Payment replay and refunds reconcile one durable grant; refunds can never be re-credited. */
export async function reconcileCreditPurchase(
  prisma: PrismaClient,
  organizationId: string,
  purchase: BillingCreditPurchase,
  now = new Date(),
) {
  if (!Number.isSafeInteger(purchase.amountCents) || purchase.amountCents < 0)
    throw new Error("Invalid credit purchase");
  await creditAccount(prisma, organizationId);
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "organizationId" FROM model_credit_accounts WHERE "organizationId" = ${organizationId} FOR UPDATE`;
    await prepareCreditLots(tx, organizationId, now);
    await expireCreditLots(tx, organizationId, now);
    const source = `purchase:${purchase.id}`;
    const existing = await tx.modelCreditEntry.findUnique({ where: { source } });
    if (existing && existing.organizationId !== organizationId)
      throw new Error("Credit purchase belongs to another account");
    if (!existing && purchase.amountCents === 0) return 0;
    const paid = BigInt(purchase.amountCents) * 10_000n;
    const amountMicros = existing && existing.amountMicros < paid ? existing.amountMicros : paid;
    const delta = amountMicros - (existing?.amountMicros ?? 0n);
    const expiresAt = purchase.expiresAt === undefined ? undefined : new Date(purchase.expiresAt);
    if (expiresAt && !Number.isFinite(expiresAt.getTime()))
      throw new Error("Invalid credit expiration");
    const previousLot = existing
      ? await tx.modelCreditLot.findUnique({ where: { id: existing.id } })
      : null;
    if (
      existing &&
      delta === 0n &&
      previousLot &&
      (!expiresAt || previousLot.expiresAt?.getTime() === expiresAt.getTime())
    )
      return 0;
    const entry = await tx.modelCreditEntry.upsert({
      where: { source },
      create: { source, organizationId, amountMicros },
      update: { amountMicros },
    });
    if (delta !== 0n)
      await tx.modelCreditAccount.update({
        where: { organizationId },
        data: { balanceMicros: { increment: delta } },
      });
    await tx.modelCreditLot.upsert({
      where: { id: entry.id },
      create: {
        id: entry.id,
        organizationId,
        amountMicros,
        availableMicros: amountMicros,
        expiresAt,
      },
      update: {},
    });
    await resizeCreditLot(tx, entry.id, amountMicros, expiresAt);
    await syncLotBalance(tx, organizationId);
    await expireCreditLots(tx, organizationId, now);
    return Number(delta);
  });
}

/** Atomic debit prevents concurrent calls from reserving the same available funds. */
export async function reserveModelCredits(
  prisma: PrismaClient,
  organizationId: string,
  maxCostUsd: number,
  attribution?: {
    callId?: string;
    userId?: string;
    spaceId?: string;
    runId?: string;
    provider?: string;
    model?: string;
  },
  now = new Date(),
) {
  if (!Number.isFinite(maxCostUsd) || maxCostUsd <= 0 || maxCostUsd > 10_000)
    throw new Error("This model has no reliable price. Connect your own API key to use it.");
  const amountMicros = BigInt(Math.ceil(maxCostUsd * MICROS_PER_DOLLAR));
  const callId = attribution?.callId ?? randomUUID();
  const source = `call:${callId}`;
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "organizationId" FROM model_credit_accounts WHERE "organizationId"=${organizationId} FOR UPDATE`;
    const existing = await tx.modelCreditEntry.findUnique({ where: { callId } });
    if (existing) {
      if (existing.organizationId !== organizationId)
        throw new Error("Model call belongs to another account");
      return existing.id;
    }
    await prepareCreditLots(tx, organizationId, now);
    await expireCreditLots(tx, organizationId, now);
    const reserved = await tx.modelCreditAccount.updateMany({
      where: { organizationId, balanceMicros: { gte: amountMicros } },
      data: { balanceMicros: { decrement: amountMicros } },
    });
    if (reserved.count !== 1)
      throw new Error(
        "Not enough model credits. Add credits in Billing or connect your own API key.",
      );
    const allocations = await allocateCreditLots(tx, organizationId, amountMicros, now);
    return (
      await tx.modelCreditEntry.create({
        data: {
          ...attribution,
          id: callId,
          callId,
          source,
          organizationId,
          amountMicros: -amountMicros,
          pending: true,
          allocations,
          fundedMicros: allocatedMicros(allocations),
          reconciliationState: "pending",
          nextReconcileAt: new Date(Date.now() + 5 * 60_000),
        },
      })
    ).id;
  });
}

/** The caller can combine usage insertion and settlement in the same transaction. */
export async function settleModelCreditsTx(
  tx: Prisma.TransactionClient,
  reservationId: string,
  costUsd: number | null,
  reconcile = false,
  now = new Date(),
) {
  if (costUsd === null) return;
  if (!Number.isFinite(costUsd) || costUsd < 0) throw new Error("Invalid model cost");
  const scope = await tx.modelCreditEntry.findUnique({ where: { id: reservationId } });
  if (!scope) return;
  await tx.$queryRaw`SELECT "organizationId" FROM model_credit_accounts WHERE "organizationId"=${scope.organizationId} FOR UPDATE`;
  await tx.$queryRaw`SELECT id FROM model_credit_entries WHERE id=${reservationId} FOR UPDATE`;
  await prepareCreditLots(tx, scope.organizationId, now);
  await expireCreditLots(tx, scope.organizationId, now);
  const entry = await tx.modelCreditEntry.findUnique({ where: { id: reservationId } });
  if (!entry || (!entry.pending && !reconcile)) return;
  const amountMicros = -BigInt(Math.ceil(costUsd * MICROS_PER_DOLLAR));
  if (!entry.pending && amountMicros === entry.amountMicros) return;
  let allocations = (entry.allocations ?? []) as CreditAllocation[];
  const difference = amountMicros - entry.amountMicros;
  if (difference > 0n) {
    const funded = allocatedMicros(allocations);
    const unfunded = -entry.amountMicros - funded;
    const refund = difference - (unfunded > 0n ? unfunded : 0n);
    if (refund > 0n) allocations = await returnCreditLots(tx, allocations, refund, now);
  } else if (difference < 0n) {
    allocations.push(...(await allocateCreditLots(tx, entry.organizationId, -difference, now)));
  }
  await tx.modelCreditEntry.update({
    where: { id: reservationId },
    data: { pending: false, amountMicros, allocations, fundedMicros: allocatedMicros(allocations) },
  });
  await tx.modelCreditAccount.update({
    where: { organizationId: entry.organizationId },
    data: { balanceMicros: { increment: amountMicros - entry.amountMicros } },
  });
  await syncLotBalance(tx, entry.organizationId);
}

/** Unknown usage leaves a visible hold; no timeout can invent a zero-cost result. */
export function settleModelCredits(
  prisma: PrismaClient,
  reservationId: string,
  costUsd: number | null,
  now = new Date(),
) {
  return prisma.$transaction((tx) => settleModelCreditsTx(tx, reservationId, costUsd, false, now));
}

/** A provider cost or a proven pre-generation stop can finalize accounting. */
export function hasFinalModelCost(
  usage: Pick<AgentUsage, "costUsd" | "costSource" | "usageSource">,
): boolean {
  return (
    usage.costUsd != null &&
    Number.isFinite(usage.costUsd) &&
    usage.costUsd >= 0 &&
    (usage.costSource === "provider-reported" ||
      (usage.costUsd === 0 &&
        ["not-started", "provider-rejected"].includes(usage.usageSource ?? "")))
  );
}

/** Persist a receipt before attempting the canonical usage + settlement transaction. */
export async function recordModelCreditReceipt(
  prisma: PrismaClient,
  id: string,
  usage: AgentUsage | null,
) {
  if (!usage) return;
  await prisma.modelCreditEntry.updateMany({
    where: { id, pending: true },
    data: {
      usage: JSON.parse(JSON.stringify(usage)),
      ...(usage.providerRequestId ? { providerRequestId: usage.providerRequestId } : {}),
    },
  });
  if (
    usage.costUsd === 0 &&
    (usage.usageSource === "not-started" || usage.usageSource === "provider-rejected")
  )
    await prisma.$transaction(async (tx) => {
      await settleModelCreditsTx(tx, id, 0);
      await tx.modelCreditEntry.updateMany({
        where: { id, reconciliationState: "pending" },
        data: { nextReconcileAt: new Date() },
      });
    });
}

/** Also called by billing reads and the background reconciler when no new invoice arrives. */
export async function expireModelCredits(
  prisma: PrismaClient,
  organizationId: string,
  now = new Date(),
) {
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "organizationId" FROM model_credit_accounts WHERE "organizationId"=${organizationId} FOR UPDATE`;
    const account = await tx.modelCreditAccount.findUnique({ where: { organizationId } });
    if (!account) return;
    await prepareCreditLots(tx, organizationId, now);
    await expireCreditLots(tx, organizationId, now);
  });
}
