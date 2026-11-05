import { randomUUID } from "node:crypto";
import type { BillingSubscriptionSnapshot } from "@rakazo/adapter-kit";
import { BYOK_TIERS } from "@rakazo/contracts";
import type { BillingAccount, PrismaClient } from "./client.js";
import { Prisma } from "./client.js";

const ACCESS_STATUSES = new Set(["trialing", "active", "past_due"]);

export function hasBillingAccess(status: string | null): boolean {
  return status !== null && ACCESS_STATUSES.has(status);
}

/**
 * Whether a model-credit organization can run bots. Any live subscription grants it, as does a
 * credit balance outside own-key mode. Otherwise only a free own-key plan or free period does.
 */
export function hasModelAccess(
  credits: { mode: string | null; balanceMicros: bigint; byokFreeUntil: Date | null },
  subscriptionStatus: string | null,
  now = new Date(),
): boolean {
  if (hasBillingAccess(subscriptionStatus)) return true;
  if (credits.mode === "byok")
    return BYOK_TIERS.standard.monthlyPriceCents === null || byokFreeUntil(credits, now) !== null;
  if (credits.balanceMicros > 0n) return true;
  return BYOK_TIERS.standard.monthlyPriceCents === null && credits.mode === "credits";
}

/** The free period's end while it is still running. */
export function byokFreeUntil(credits: { byokFreeUntil: Date | null }, now = new Date()) {
  return credits.byokFreeUntil && credits.byokFreeUntil > now ? credits.byokFreeUntil : null;
}

export const FREE_MONTH_DAYS = 30;
/** How long an open checkout session holds the owner's trial; sessions live about a day. */
const BYOK_TRIAL_CHECKOUT_HOLD_MS = 24 * 60 * 60 * 1000;

/** One statement, so concurrent grants each add their days. */
export async function extendByokFreePeriod(
  tx: Prisma.TransactionClient,
  organizationId: string,
  days: number,
) {
  await tx.$executeRaw`
    UPDATE model_credit_accounts
    SET "byokFreeUntil" = GREATEST(COALESCE("byokFreeUntil", now()), now()) + make_interval(days => ${days}::int)
    WHERE "organizationId" = ${organizationId}`;
  // The free days are the owners' own-key trial, used even if the organization later goes away.
  await markOwnersByokTrialUsed(tx, { id: organizationId });
}

const SUBSCRIBED: Prisma.OrganizationWhereInput = {
  billing: { is: { subscribedAt: { not: null } } },
};
const HAD_FREE_DAYS: Prisma.OrganizationWhereInput = {
  modelCredits: { is: { byokFreeUntil: { not: null } } },
};

/** Survives the organization, so deleting it never earns its owner another trial. */
async function markOwnersTrialUsed(
  db: Pick<PrismaClient, "user"> | Prisma.TransactionClient,
  organization: Prisma.OrganizationWhereInput,
) {
  await db.user.updateMany({
    where: {
      billingTrialUsedAt: null,
      members: { some: { organization, role: { contains: "owner" } } },
    },
    data: { billingTrialUsedAt: new Date() },
  });
}

/** Free own-key days use up only the own-key trial, and survive the organization they belonged to. */
async function markOwnersByokTrialUsed(
  db: Pick<PrismaClient, "user"> | Prisma.TransactionClient,
  organization: Prisma.OrganizationWhereInput,
) {
  await db.user.updateMany({
    where: {
      byokTrialUsedAt: null,
      members: { some: { organization, role: { contains: "owner" } } },
    },
    data: { byokTrialUsedAt: new Date() },
  });
}

/** A hold one checkout attempt took on the owners' one own-key trial. */
export type ByokTrialCheckoutHold = {
  /** Identifies this attempt's hold, so giving it back cannot touch another session's. */
  expiresAt: Date;
  /** The hold an earlier open session of the same organization still had, to fall back to. */
  previousExpiresAt: Date | null;
};

/**
 * Takes the owners' one own-key trial for this organization's checkout session, so another
 * organization of theirs cannot take it while the session is open. The hold lasts as long as
 * the session can still be paid, and moving to the same organization's newest session renews
 * it. Returns null when a fresh hold for another organization wins the race.
 */
export async function reserveByokTrialCheckout(
  prisma: PrismaClient,
  organizationId: string,
): Promise<ByokTrialCheckoutHold | null> {
  const owners = await prisma.member.findMany({
    where: { organizationId, role: { contains: "owner" } },
    select: { userId: true, role: true },
  });
  const ownerIds = owners.filter((owner) => isOwnerRole(owner.role)).map((owner) => owner.userId);
  if (ownerIds.length === 0) return null;
  // The same organization's earlier open session keeps its hold while this attempt runs.
  const previous = await prisma.user.findFirst({
    where: { id: { in: ownerIds }, byokTrialCheckoutOrganizationId: organizationId },
    select: { byokTrialCheckoutExpiresAt: true },
  });
  const expiresAt = new Date(Date.now() + BYOK_TRIAL_CHECKOUT_HOLD_MS);
  const { count } = await prisma.user.updateMany({
    where: {
      id: { in: ownerIds },
      billingTrialUsedAt: null,
      byokTrialUsedAt: null,
      OR: [
        { byokTrialCheckoutOrganizationId: null },
        { byokTrialCheckoutOrganizationId: organizationId },
        { byokTrialCheckoutExpiresAt: { lte: new Date() } },
      ],
    },
    data: {
      byokTrialCheckoutOrganizationId: organizationId,
      byokTrialCheckoutExpiresAt: expiresAt,
    },
  });
  return count === ownerIds.length
    ? { expiresAt, previousExpiresAt: previous?.byokTrialCheckoutExpiresAt ?? null }
    : null;
}

/**
 * Gives back a hold `reserveByokTrialCheckout` returned once the provider refused to create
 * the session: this attempt's hold goes, and an earlier open session's hold is restored.
 */
export async function releaseByokTrialCheckout(
  prisma: PrismaClient,
  organizationId: string,
  hold: ByokTrialCheckoutHold,
): Promise<void> {
  await prisma.user.updateMany({
    where: {
      byokTrialCheckoutOrganizationId: organizationId,
      byokTrialCheckoutExpiresAt: hold.expiresAt,
    },
    data: hold.previousExpiresAt
      ? { byokTrialCheckoutExpiresAt: hold.previousExpiresAt }
      : { byokTrialCheckoutOrganizationId: null, byokTrialCheckoutExpiresAt: null },
  });
}

/** Moves the hold to the moment the session was created, which is when it starts expiring. */
export async function extendByokTrialCheckout(
  prisma: PrismaClient,
  organizationId: string,
  hold: ByokTrialCheckoutHold,
): Promise<void> {
  await prisma.user.updateMany({
    where: {
      byokTrialCheckoutOrganizationId: organizationId,
      byokTrialCheckoutExpiresAt: hold.expiresAt,
    },
    data: { byokTrialCheckoutExpiresAt: new Date(Date.now() + BYOK_TRIAL_CHECKOUT_HOLD_MS) },
  });
}

/** Releases every hold the organization's open checkout sessions had on their owners' trial. */
export async function releaseByokTrialCheckouts(
  prisma: PrismaClient,
  organizationId: string,
): Promise<void> {
  await prisma.user.updateMany({
    where: { byokTrialCheckoutOrganizationId: organizationId },
    data: { byokTrialCheckoutOrganizationId: null, byokTrialCheckoutExpiresAt: null },
  });
}

export async function spaceHasModelAccess(prisma: PrismaClient, spaceId: string) {
  const space = await prisma.space.findUnique({
    where: { id: spaceId },
    select: {
      organization: {
        select: {
          modelCredits: { select: { mode: true, balanceMicros: true, byokFreeUntil: true } },
          billing: { select: { status: true } },
        },
      },
    },
  });
  if (!space) return false;
  const { modelCredits, billing } = space.organization;
  return hasModelAccess(
    modelCredits ?? { mode: null, balanceMicros: 0n, byokFreeUntil: null },
    billing?.status ?? null,
  );
}

export function billingAccountForOrganization(
  prisma: PrismaClient,
  organizationId: string,
): Promise<BillingAccount | null> {
  return prisma.billingAccount.findUnique({ where: { organizationId } });
}

/** Idempotent per organization: a concurrent create keeps the first stored customer. */
export async function createBillingAccount(
  prisma: PrismaClient,
  input: { organizationId: string; customerId: string },
): Promise<BillingAccount> {
  try {
    return await prisma.billingAccount.upsert({
      where: { organizationId: input.organizationId },
      create: input,
      update: {},
    });
  } catch (error) {
    // An empty update is not a native upsert, so a concurrent create can still collide.
    if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")) {
      throw error;
    }
    const existing = await billingAccountForOrganization(prisma, input.organizationId);
    if (!existing) throw error;
    return existing;
  }
}

/**
 * Points the organization at a new customer after the provider deleted the old one, clearing the
 * old subscription snapshot but keeping `subscribedAt` so no second trial is offered. When a
 * concurrent request already swapped it, that swap wins. Returns the stored account.
 */
export async function replaceBillingCustomer(
  prisma: PrismaClient,
  input: { organizationId: string; previousCustomerId: string; customerId: string },
): Promise<BillingAccount> {
  await prisma.billingAccount.updateMany({
    where: { organizationId: input.organizationId, customerId: input.previousCustomerId },
    data: {
      customerId: input.customerId,
      creditAmountCents: null,
      byokPriceCents: null,
      byokInterval: null,
      byokTier: null,
      subscriptionId: null,
      subscriptionItemId: null,
      priceId: null,
      status: null,
      seats: null,
      trialEndsAt: null,
      currentPeriodStartsAt: null,
      currentPeriodEndsAt: null,
      cancelAtPeriodEnd: false,
      endedAt: null,
      cancellationReason: null,
      cancellationComment: null,
      syncedAt: null,
    },
  });
  return prisma.billingAccount.findUniqueOrThrow({
    where: { organizationId: input.organizationId },
  });
}

/**
 * Claims the organization's checkout lease, coordinating API instances without holding a
 * connection over provider calls. Returns the lease id, or null while another request holds it.
 */
export async function claimCheckoutLease(
  prisma: PrismaClient,
  organizationId: string,
  ttlMs: number,
): Promise<string | null> {
  const leaseId = randomUUID();
  const now = new Date();
  const { count } = await prisma.billingAccount.updateMany({
    where: {
      organizationId,
      OR: [{ checkoutLeaseExpiresAt: null }, { checkoutLeaseExpiresAt: { lte: now } }],
    },
    data: { checkoutLeaseId: leaseId, checkoutLeaseExpiresAt: new Date(now.getTime() + ttlMs) },
  });
  return count > 0 ? leaseId : null;
}

export async function releaseCheckoutLease(
  prisma: PrismaClient,
  organizationId: string,
  leaseId: string,
): Promise<void> {
  await prisma.billingAccount.updateMany({
    where: { organizationId, checkoutLeaseId: leaseId },
    data: { checkoutLeaseId: null, checkoutLeaseExpiresAt: null },
  });
}

/**
 * Extends the lease while its holder is still the recorded owner and the lease has not lapsed;
 * a lapsed lease is left to the next claimant instead of being resurrected.
 */
export async function renewCheckoutLease(
  prisma: PrismaClient,
  organizationId: string,
  leaseId: string,
  ttlMs: number,
): Promise<boolean> {
  const now = new Date();
  const { count } = await prisma.billingAccount.updateMany({
    where: {
      organizationId,
      checkoutLeaseId: leaseId,
      checkoutLeaseExpiresAt: { gt: now },
    },
    data: { checkoutLeaseExpiresAt: new Date(now.getTime() + ttlMs) },
  });
  return count > 0;
}

/** Whether the checkout lease is still recorded for this holder. */
export async function checkoutLeaseHeld(
  prisma: PrismaClient,
  organizationId: string,
  leaseId: string,
): Promise<boolean> {
  const held = await prisma.billingAccount.findFirst({
    where: { organizationId, checkoutLeaseId: leaseId },
    select: { organizationId: true },
  });
  return held !== null;
}

/** The subscription exists but has no access until the owner settles it in the billing portal. */
export function needsBillingPortal(status: string | null): boolean {
  return status === "unpaid" || status === "paused";
}

/**
 * Loads the customer's current subscription and overwrites the stored snapshot (`null` clears
 * it). The write only lands if no sync that started later has written first, so an older read
 * never replaces a newer one. Returns false when no account is stored for the customer.
 */
export async function syncBillingSnapshot(
  prisma: PrismaClient,
  customerId: string,
  load: () => Promise<BillingSubscriptionSnapshot | null>,
): Promise<boolean> {
  // The database clock, so API instances with skewed clocks still order correctly.
  const [{ startedAt }] = await prisma.$queryRaw<[{ startedAt: Date }]>(
    Prisma.sql`SELECT clock_timestamp() AS "startedAt"`,
  );
  const snapshot = await load();
  const written = await prisma.billingAccount.updateMany({
    where: { customerId, OR: [{ syncedAt: null }, { syncedAt: { lt: startedAt } }] },
    data: {
      creditAmountCents: snapshot?.creditAmountCents ?? null,
      byokPriceCents: snapshot?.byokPriceCents ?? null,
      byokInterval: snapshot?.byokInterval ?? null,
      byokTier: snapshot?.byokTier ?? null,
      subscriptionId: snapshot?.subscriptionId ?? null,
      subscriptionItemId: snapshot?.subscriptionItemId ?? null,
      priceId: snapshot?.priceId ?? null,
      status: snapshot?.status ?? null,
      seats: snapshot?.seats ?? null,
      trialEndsAt: snapshot?.trialEndsAt ?? null,
      currentPeriodStartsAt: snapshot?.currentPeriodStartsAt ?? null,
      currentPeriodEndsAt: snapshot?.currentPeriodEndsAt ?? null,
      cancelAtPeriodEnd: snapshot?.cancelAtPeriodEnd ?? false,
      endedAt: snapshot?.endedAt ?? null,
      cancellationReason: snapshot?.cancellationReason ?? null,
      cancellationComment: snapshot?.cancellationComment ?? null,
      syncedAt: startedAt,
    },
  });
  if (snapshot) {
    await prisma.billingAccount.updateMany({
      where: { customerId, subscribedAt: null },
      data: { subscribedAt: startedAt },
    });
    await markOwnersTrialUsed(prisma, { billing: { is: { customerId } } });
  }
  if (snapshot?.status === "active") {
    await prisma.billingAccount.updateMany({
      where: { customerId, paidAt: null },
      data: { paidAt: startedAt },
    });
  }
  if (written.count > 0) return true;
  return (await prisma.billingAccount.count({ where: { customerId } })) > 0;
}

/** Billable seats: every organization member, never fewer than one. */
export async function organizationSeatCount(
  prisma: PrismaClient,
  organizationId: string,
): Promise<number> {
  const members = await prisma.member.count({ where: { organizationId } });
  return Math.max(1, members);
}

export async function organizationForMember(
  prisma: PrismaClient,
  input: { spaceId: string; userId: string },
): Promise<{ organizationId: string; isOwner: boolean } | null> {
  const space = await prisma.space.findUnique({
    where: { id: input.spaceId },
    select: { organizationId: true },
  });
  if (!space) return null;
  const member = await prisma.member.findUnique({
    where: {
      organizationId_userId: { organizationId: space.organizationId, userId: input.userId },
    },
    select: { role: true },
  });
  if (!member) return null;
  return { organizationId: space.organizationId, isOwner: isOwnerRole(member.role) };
}

export async function ownedBillingAccounts(
  prisma: PrismaClient,
  userId: string,
): Promise<BillingAccount[]> {
  const memberships = await prisma.member.findMany({
    where: { userId, organization: { billing: { isNot: null } } },
    select: { role: true, organization: { select: { billing: true } } },
  });
  return memberships.flatMap((membership) =>
    isOwnerRole(membership.role) && membership.organization.billing
      ? [membership.organization.billing]
      : [],
  );
}

/** Before an organization's billing rows go, so a subscription that predates the user-level mark still counts. */
export async function keepOrganizationTrialUse(prisma: PrismaClient, organizationId: string) {
  await markOwnersTrialUsed(prisma, { id: organizationId, ...SUBSCRIBED });
  // Free own-key days granted before the owner-level mark existed also outlast the rows.
  await markOwnersByokTrialUsed(prisma, { id: organizationId, ...HAD_FREE_DAYS });
}

/**
 * One trial per person: any subscription uses it up. Free own-key days also use up the own-key
 * trial, but not the managed plan's, and so does another organization's still-open trial
 * checkout. Organizations that subscribed before the user-level mark existed still count, so
 * older accounts need no backfill.
 */
export async function ownerHadTrial(
  prisma: PrismaClient,
  userId: string,
  plan: "byok" | "managed",
  forOrganizationId?: string,
): Promise<boolean> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      billingTrialUsedAt: true,
      byokTrialUsedAt: true,
      byokTrialCheckoutOrganizationId: true,
      byokTrialCheckoutExpiresAt: true,
    },
  });
  if (user?.billingTrialUsedAt) return true;
  if (plan === "byok") {
    if (user?.byokTrialUsedAt) return true;
    // The owner's own open session keeps their trial available; another organization's holds it.
    if (
      user?.byokTrialCheckoutExpiresAt &&
      user.byokTrialCheckoutExpiresAt > new Date() &&
      user.byokTrialCheckoutOrganizationId !== forOrganizationId
    )
      return true;
  }
  const used = await prisma.member.findFirst({
    where: {
      userId,
      role: { contains: "owner" },
      organization: plan === "byok" ? { OR: [SUBSCRIBED, HAD_FREE_DAYS] } : SUBSCRIBED,
    },
    select: { id: true },
  });
  return used !== null;
}

/** Whether the organization's owner has used their one trial, whichever member is asking. */
export async function organizationOwnerHadTrial(
  prisma: PrismaClient,
  organizationId: string,
  plan: "byok" | "managed",
): Promise<boolean> {
  const members = await prisma.member.findMany({
    where: { organizationId, role: { contains: "owner" } },
    select: { userId: true, role: true },
  });
  for (const member of members) {
    if (
      isOwnerRole(member.role) &&
      (await ownerHadTrial(prisma, member.userId, plan, organizationId))
    )
      return true;
  }
  return false;
}

function isOwnerRole(role: string): boolean {
  return role
    .split(",")
    .map((value) => value.trim())
    .includes("owner");
}
