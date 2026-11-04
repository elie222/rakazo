import { randomUUID } from "node:crypto";
import type { BillingSubscriptionSnapshot } from "@rakazo/adapter-kit";
import { BYOK_TIERS } from "@rakazo/contracts";
import type { BillingAccount, PrismaClient } from "./client.js";
import { Prisma } from "./client.js";
import { IsolationError } from "./scope.js";

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

/** Billable seats: every organization member but guests, never fewer than one. */
export async function organizationSeatCount(
  prisma: PrismaClient,
  organizationId: string,
): Promise<number> {
  const members = await prisma.member.count({
    where: { organizationId, role: { not: GUEST_ROLE } },
  });
  return Math.max(1, members);
}

/** The org role of someone who belongs to an organization only through Spaces they were invited to. */
export const GUEST_ROLE = "guest";

/** The oldest organization the user owns, where their own Spaces live. */
export async function ownedOrganizationId(
  db: Pick<PrismaClient, "member">,
  userId: string,
): Promise<string> {
  const memberships = await db.member.findMany({
    where: { userId },
    select: { organizationId: true, role: true },
    orderBy: { createdAt: "asc" },
  });
  const owned = memberships.find((membership) => isOwnerRole(membership.role));
  if (!owned) throw new IsolationError();
  return owned.organizationId;
}

/**
 * The organization that pays for this person's work in a Space: the Space's own, or for a guest
 * their own oldest organization, so a shared Space never bills its owner for someone else.
 */
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
  if (member.role === GUEST_ROLE) {
    return { organizationId: await ownedOrganizationId(prisma, input.userId), isOwner: true };
  }
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
}

/**
 * One trial per person: any subscription uses it up. Free own-key days also use up the own-key
 * trial, but not the managed plan's. Organizations that subscribed before the user-level mark
 * existed still count, so older accounts need no backfill.
 */
export async function ownerHadTrial(
  prisma: PrismaClient,
  userId: string,
  plan: "byok" | "managed",
): Promise<boolean> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { billingTrialUsedAt: true },
  });
  if (user?.billingTrialUsedAt) return true;
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
    if (isOwnerRole(member.role) && (await ownerHadTrial(prisma, member.userId, plan))) return true;
  }
  return false;
}

/** Better Auth stores roles as a comma-separated list. */
export function isOwnerRole(role: string): boolean {
  return role
    .split(",")
    .map((value) => value.trim())
    .includes("owner");
}
