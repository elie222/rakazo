import { ORPCError } from "@orpc/server";
import type { BillingPrice, BillingProvider } from "@rakazo/adapter-kit";
import { BillingCheckoutCompletedError, BillingCustomerNotFoundError } from "@rakazo/adapter-kit";
import type { Actor, BillingStatus } from "@rakazo/contracts";
import type { BillingAccount, PrismaClient } from "@rakazo/db";
import {
  billingAccountForOrganization,
  createBillingAccount,
  creditAccount,
  expireModelCredits,
  hasBillingAccess,
  MICROS_PER_DOLLAR,
  needsBillingPortal,
  organizationForMember,
  organizationSeatCount,
  ownedBillingAccounts,
  reconcileCreditPurchase,
  replaceBillingCustomer,
  syncBillingSnapshot,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";

export const TRIAL_DAYS = 7;
const PRICE_CACHE_MS = 60 * 60 * 1000;
/** Stripe returns here after checkout; served by the API through the web origin. */
export const BILLING_RETURN_PATH = "/api/v1/billing/return";

/** Product-side billing: access rules, checkout, and pull-based sync from the provider. */
export interface BillingService {
  readonly modelCreditsEnabled: boolean;
  status(actor: Actor): Promise<BillingStatus>;
  selectFunding(actor: Actor, funding: "byok" | "credits"): Promise<{ ok: true }>;
  purchaseCredits(
    actor: Actor,
    input: { amountCents: number; monthly: boolean },
  ): Promise<{ url: string }>;
  setMonthlyCredits(actor: Actor, amountCents: number): Promise<{ ok: true }>;
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
  managedModelsAvailable?: boolean;
  /** The session cookie lives on the web origin, which also proxies /api to this server. */
  webOrigin: string;
}): BillingService {
  const { prisma, provider } = deps;
  const appUrl = `${deps.webOrigin}/app`;
  const modelCredits = provider.describe().capabilities.modelCredits === true;
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
    if (modelCredits && provider.listCreditPurchases) {
      const account = await prisma.billingAccount.findUnique({ where: { customerId } });
      if (account) {
        let added = false;
        for (const purchase of await provider.listCreditPurchases(customerId)) {
          if ((await reconcileCreditPurchase(prisma, account.organizationId, purchase)) > 0)
            added = true;
        }
        await prisma.modelCreditAccount.updateMany({
          where: {
            organizationId: account.organizationId,
            balanceMicros: { gt: 0n },
            OR: [{ mode: null }, ...(added ? [{ pendingCreditCheckout: true }] : [])],
          },
          data: { mode: "credits", pendingCreditCheckout: false },
        });
      }
    }
    const written = await syncBillingSnapshot(prisma, customerId, () =>
      provider.getCustomerSubscription(customerId),
    );
    if (!written)
      getLogger().warn("billing sync for unknown customer", { "billing.customer_id": customerId });
  }

  async function newCustomer(actor: Actor, organizationId: string) {
    return (await provider.createCustomer({ email: actor.email, organizationId })).customerId;
  }

  /** Runs `call`; if the provider deleted the customer, swaps in a new one and runs it again. */
  async function withLiveCustomer<T>(
    actor: Actor,
    account: BillingAccount,
    call: (customerId: string) => Promise<T>,
  ): Promise<T> {
    try {
      return await call(account.customerId);
    } catch (error) {
      if (!(error instanceof BillingCustomerNotFoundError)) throw error;
      const replaced = await replaceBillingCustomer(prisma, {
        organizationId: account.organizationId,
        previousCustomerId: account.customerId,
        customerId: await newCustomer(actor, account.organizationId),
      });
      return call(replaced.customerId);
    }
  }

  return {
    modelCreditsEnabled: modelCredits,
    async selectFunding(actor, funding) {
      const { organizationId } = await managedOrganization(actor);
      const account = await creditAccount(prisma, organizationId);
      if (funding === "byok") {
        const subscription = await billingAccountForOrganization(prisma, organizationId);
        if (
          subscription?.creditAmountCents &&
          !subscription.cancelAtPeriodEnd &&
          !["canceled", "incomplete_expired"].includes(subscription.status ?? "")
        )
          throw new ORPCError("CONFLICT", {
            message: "Cancel monthly credits in Billing before switching to your API key.",
          });
      }
      await prisma.modelCreditAccount.update({
        where: { organizationId },
        data: {
          mode: funding === "byok" ? "byok" : account.balanceMicros > 0n ? "credits" : null,
          pendingCreditCheckout: false,
        },
      });
      return { ok: true };
    },

    async purchaseCredits(actor, input) {
      if (!modelCredits || !provider.createCreditCheckout) throw new ORPCError("NOT_FOUND");
      if (deps.managedModelsAvailable === false) throw new ORPCError("PRECONDITION_FAILED");
      const { organizationId } = await managedOrganization(actor);
      let account = await billingAccountForOrganization(prisma, organizationId);
      if (!account)
        account = await createBillingAccount(prisma, {
          organizationId,
          customerId: await newCustomer(actor, organizationId),
        });
      await creditAccount(prisma, organizationId);
      try {
        const checkout = await prisma.$transaction(
          async (tx) => {
            // Serialize recurring checkout across API instances: opening another expires the old one.
            if (input.monthly)
              await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`model-credit-checkout:${organizationId}`}, 0))`;
            return withLiveCustomer(actor, account, (customerId) =>
              provider.createCreditCheckout!({
                customerId,
                ...input,
                successUrl: `${deps.webOrigin}${BILLING_RETURN_PATH}`,
                cancelUrl: `${appUrl}?billing=canceled`,
              }),
            );
          },
          { timeout: 120_000 },
        );
        await prisma.modelCreditAccount.update({
          where: { organizationId },
          data: { pendingCreditCheckout: true },
        });
        return checkout;
      } catch (error) {
        if (error instanceof BillingCheckoutCompletedError)
          throw new ORPCError("CONFLICT", {
            message: "Manage your existing subscription in Billing",
          });
        throw error;
      }
    },

    async setMonthlyCredits(actor, amountCents) {
      if (!modelCredits || !provider.setMonthlyCredits) throw new ORPCError("NOT_FOUND");
      const { organizationId } = await managedOrganization(actor);
      const account = await billingAccountForOrganization(prisma, organizationId);
      if (!account) throw new ORPCError("NOT_FOUND");
      await provider.setMonthlyCredits(account.customerId, amountCents);
      await sync(account.customerId);
      return { ok: true };
    },

    async status(actor) {
      if (modelCredits) {
        const { organizationId, isOwner } = await organization(actor);
        await expireModelCredits(prisma, organizationId);
        const [credits, account] = await Promise.all([
          creditAccount(prisma, organizationId),
          billingAccountForOrganization(prisma, organizationId),
        ]);
        return {
          access: credits.mode !== null || credits.balanceMicros > 0n,
          funding:
            credits.mode === "byok"
              ? "byok"
              : credits.balanceMicros > 0n || credits.mode === "credits"
                ? "credits"
                : null,
          balanceUsd: Number(credits.balanceMicros) / MICROS_PER_DOLLAR,
          monthlyAmountCents: account?.creditAmountCents ?? null,
          creditPurchasesEnabled: deps.managedModelsAvailable ?? true,
          canManage: isOwner,
          trialAvailable: false,
          trialDays: 0,
          state: (account?.status ?? "none") as BillingStatus["state"],
          price: account?.creditAmountCents
            ? {
                amount: account.creditAmountCents,
                currency: "usd",
                interval: "month" as const,
                intervalCount: 1,
              }
            : null,
          seats: 1,
          trialEndsAt: null,
          currentPeriodEndsAt: account?.currentPeriodEndsAt?.toISOString() ?? null,
          cancelAtPeriodEnd: account?.cancelAtPeriodEnd ?? false,
          hasCustomer: Boolean(account),
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
      // The existing subscription resumes once paid; a new checkout would bill twice.
      if (needsBillingPortal(account?.status ?? null)) {
        throw new ORPCError("CONFLICT", { message: "Resume the subscription in billing" });
      }
      account ??= await createBillingAccount(prisma, {
        organizationId,
        customerId: await newCustomer(actor, organizationId),
      });
      const seats = await organizationSeatCount(prisma, organizationId);
      const trial = account.subscribedAt ? {} : { trialDays: TRIAL_DAYS };
      try {
        return await withLiveCustomer(actor, account, (customerId) =>
          provider.createCheckout({
            customerId,
            seats,
            ...trial,
            successUrl: `${deps.webOrigin}${BILLING_RETURN_PATH}`,
            cancelUrl: appUrl,
          }),
        );
      } catch (error) {
        if (!(error instanceof BillingCheckoutCompletedError)) throw error;
        await sync(account.customerId);
        throw new ORPCError("CONFLICT", { message: "Already subscribed" });
      }
    },

    async portal(actor) {
      const { organizationId } = await managedOrganization(actor);
      const account = await billingAccountForOrganization(prisma, organizationId);
      if (!account) throw new ORPCError("NOT_FOUND", { message: "No billing account" });
      return withLiveCustomer(actor, account, (customerId) =>
        provider.createPortal({ customerId, returnUrl: appUrl }),
      );
    },

    sync,

    async syncForActor(actor) {
      const { organizationId } = await organization(actor);
      const account = await billingAccountForOrganization(prisma, organizationId);
      if (account) await sync(account.customerId);
    },

    async syncSeats(organizationId) {
      const account = await billingAccountForOrganization(prisma, organizationId);
      if (!account || account.creditAmountCents) return;
      const seats = await organizationSeatCount(prisma, organizationId);
      if (account.seats === seats) return;
      await provider.updateSeats(account.customerId, seats);
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
