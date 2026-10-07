import type { BillingSubscriptionSnapshot } from "@rakazo/adapter-kit";
import type { BillingAccount, PrismaClient } from "./client.js";
import { Prisma } from "./client.js";

/** Subscription states that let an organization use the product. */
const ACCESS_STATUSES = new Set(["trialing", "active", "past_due"]);

export function hasBillingAccess(status: string | null): boolean {
  return status !== null && ACCESS_STATUSES.has(status);
}

export function billingAccountForOrganization(
  prisma: PrismaClient,
  organizationId: string,
): Promise<BillingAccount | null> {
  return prisma.billingAccount.findUnique({ where: { organizationId } });
}

/** Idempotent per organization: a concurrent create keeps the first stored customer. */
export function createBillingAccount(
  prisma: PrismaClient,
  input: { organizationId: string; customerId: string },
): Promise<BillingAccount> {
  return prisma.billingAccount.upsert({
    where: { organizationId: input.organizationId },
    create: input,
    update: {},
  });
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
      subscriptionId: snapshot?.subscriptionId ?? null,
      subscriptionItemId: snapshot?.subscriptionItemId ?? null,
      priceId: snapshot?.priceId ?? null,
      status: snapshot?.status ?? null,
      seats: snapshot?.seats ?? null,
      trialEndsAt: snapshot?.trialEndsAt ?? null,
      currentPeriodEndsAt: snapshot?.currentPeriodEndsAt ?? null,
      cancelAtPeriodEnd: snapshot?.cancelAtPeriodEnd ?? false,
      endedAt: snapshot?.endedAt ?? null,
      syncedAt: startedAt,
    },
  });
  if (snapshot) {
    await prisma.billingAccount.updateMany({
      where: { customerId, subscribedAt: null },
      data: { subscribedAt: startedAt },
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

/** Organizations the user owns that have a billing customer. */
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

function isOwnerRole(role: string): boolean {
  return role
    .split(",")
    .map((value) => value.trim())
    .includes("owner");
}
