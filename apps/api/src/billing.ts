import { ORPCError } from "@orpc/server";
import type { BillingPrice, BillingProvider } from "@rakazo/adapter-kit";
import type { Actor, BillingStatus } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import {
  billingAccountForOrganization,
  createBillingAccount,
  hasBillingAccess,
  organizationForMember,
  organizationSeatCount,
  ownedBillingAccounts,
  syncBillingSnapshot,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";

export const TRIAL_DAYS = 7;
const PRICE_CACHE_MS = 60 * 60 * 1000;
/** Stripe returns here after checkout; served by the API through the web origin. */
export const BILLING_RETURN_PATH = "/api/v1/billing/return";

/** Product-side billing: access rules, checkout, and pull-based sync from the provider. */
export interface BillingService {
  status(actor: Actor): Promise<BillingStatus>;
  checkout(actor: Actor): Promise<{ url: string }>;
  portal(actor: Actor): Promise<{ url: string }>;
  /** Re-fetches the customer's subscription from the provider and overwrites the stored snapshot. */
  sync(customerId: string): Promise<void>;
  /** Syncs the actor's organization, e.g. on return from checkout before the webhook lands. */
  syncForActor(actor: Actor): Promise<void>;
  /** Pushes the organization's member count to the provider. Call when members change. */
  syncSeats(organizationId: string): Promise<void>;
  cancelForDeletedUser(userId: string): Promise<void>;
}

export function createBillingService(deps: {
  prisma: PrismaClient;
  provider: BillingProvider;
  /** The session cookie lives on the web origin, which also proxies /api to this server. */
  webOrigin: string;
}): BillingService {
  const { prisma, provider } = deps;
  const appUrl = `${deps.webOrigin}/app`;
  let cachedPrice: { value: BillingPrice; expiresAt: number } | undefined;

  async function price(): Promise<BillingPrice | null> {
    if (cachedPrice && cachedPrice.expiresAt > Date.now()) return cachedPrice.value;
    try {
      const value = await provider.getPrice();
      cachedPrice = { value, expiresAt: Date.now() + PRICE_CACHE_MS };
      return value;
    } catch (error) {
      getLogger().error("billing price lookup failed", error);
      return null;
    }
  }

  async function organization(actor: Actor) {
    const found = await organizationForMember(prisma, {
      spaceId: actor.spaceId,
      userId: actor.userId,
    });
    if (!found) throw new ORPCError("FORBIDDEN");
    return found;
  }

  async function managedOrganization(actor: Actor) {
    const found = await organization(actor);
    if (!found.isOwner) throw new ORPCError("FORBIDDEN");
    return found;
  }

  async function sync(customerId: string): Promise<void> {
    const written = await syncBillingSnapshot(prisma, customerId, () =>
      provider.getCustomerSubscription(customerId),
    );
    if (!written)
      getLogger().warn("billing sync for unknown customer", { "billing.customer_id": customerId });
  }

  return {
    async status(actor) {
      if (actor.isDeploymentOwner) {
        return {
          access: true,
          canManage: false,
          trialAvailable: false,
          trialDays: TRIAL_DAYS,
          state: "none",
          price: null,
          seats: 0,
          trialEndsAt: null,
          currentPeriodEndsAt: null,
          cancelAtPeriodEnd: false,
          hasCustomer: false,
        };
      }
      const { organizationId, isOwner } = await organization(actor);
      const [account, currentPrice] = await Promise.all([
        billingAccountForOrganization(prisma, organizationId),
        price(),
      ]);
      const status = account?.status ?? null;
      return {
        access: hasBillingAccess(status),
        canManage: isOwner,
        trialAvailable: !account?.subscribedAt,
        trialDays: TRIAL_DAYS,
        state: (status ?? "none") as BillingStatus["state"],
        price: currentPrice,
        seats: account?.seats ?? (await organizationSeatCount(prisma, organizationId)),
        trialEndsAt: account?.trialEndsAt?.toISOString() ?? null,
        currentPeriodEndsAt: account?.currentPeriodEndsAt?.toISOString() ?? null,
        cancelAtPeriodEnd: account?.cancelAtPeriodEnd ?? false,
        hasCustomer: Boolean(account),
      };
    },

    async checkout(actor) {
      const { organizationId } = await managedOrganization(actor);
      let account = await billingAccountForOrganization(prisma, organizationId);
      if (account) {
        // Decide from the provider, not a snapshot a missed webhook may have left stale.
        await sync(account.customerId);
        account = await billingAccountForOrganization(prisma, organizationId);
      }
      if (hasBillingAccess(account?.status ?? null)) {
        throw new ORPCError("CONFLICT", { message: "Already subscribed" });
      }
      if (!account) {
        const { customerId } = await provider.createCustomer({
          email: actor.email,
          organizationId,
        });
        account = await createBillingAccount(prisma, { organizationId, customerId });
      }
      return provider.createCheckout({
        customerId: account.customerId,
        seats: await organizationSeatCount(prisma, organizationId),
        ...(account.subscribedAt ? {} : { trialDays: TRIAL_DAYS }),
        successUrl: `${deps.webOrigin}${BILLING_RETURN_PATH}`,
        cancelUrl: appUrl,
      });
    },

    async portal(actor) {
      const { organizationId } = await managedOrganization(actor);
      const account = await billingAccountForOrganization(prisma, organizationId);
      if (!account) throw new ORPCError("NOT_FOUND", { message: "No billing account" });
      return provider.createPortal({ customerId: account.customerId, returnUrl: appUrl });
    },

    sync,

    async syncForActor(actor) {
      const { organizationId } = await organization(actor);
      const account = await billingAccountForOrganization(prisma, organizationId);
      if (account) await sync(account.customerId);
    },

    async syncSeats(organizationId) {
      const account = await billingAccountForOrganization(prisma, organizationId);
      if (!account?.subscriptionItemId) return;
      const seats = await organizationSeatCount(prisma, organizationId);
      if (account.seats === seats) return;
      await provider.updateSeats(account.subscriptionItemId, seats);
      await sync(account.customerId);
    },

    async cancelForDeletedUser(userId) {
      for (const account of await ownedBillingAccounts(prisma, userId)) {
        await provider.cancelCustomerSubscriptions(account.customerId);
        await sync(account.customerId);
      }
    },
  };
}
