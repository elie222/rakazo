import { setTimeout as sleep } from "node:timers/promises";
import { ORPCError } from "@orpc/server";
import type {
  BillingPrice,
  BillingProvider,
  BillingSubscriptionSnapshot,
  SandboxProvider,
} from "@rakazo/adapter-kit";
import {
  BillingCheckoutCompletedError,
  BillingCustomerNotFoundError,
  BillingNoMonthlyCreditsError,
} from "@rakazo/adapter-kit";
import { sandboxAllowance, sandboxHoursLeft } from "@rakazo/adapters";
import type { Actor, BillingStatus } from "@rakazo/contracts";
import { BYOK_MONTHLY_PRICE_CENTS } from "@rakazo/contracts";
import type { BillingAccount, PrismaClient } from "@rakazo/db";
import {
  billingAccountForOrganization,
  byokFreeUntil,
  claimCheckoutLease,
  createBillingAccount,
  creditAccount,
  expireModelCredits,
  hasBillingAccess,
  hasModelAccess,
  MICROS_PER_DOLLAR,
  needsBillingPortal,
  organizationForMember,
  organizationSeatCount,
  ownedBillingAccounts,
  reconcileCreditPurchase,
  releaseCheckoutLease,
  replaceBillingCustomer,
  syncBillingSnapshot,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { createReferrals } from "./referrals.js";

export const TRIAL_DAYS = 7;
const PRICE_CACHE_MS = 60 * 60 * 1000;
const CHECKOUT_LEASE_MS = 120_000;
const CHECKOUT_LEASE_POLL_MS = 250;
/** Stripe returns here after checkout; served by the API through the web origin. */
export const BILLING_RETURN_PATH = "/api/v1/billing/return";

/** Where checkout was opened; the mobile app's in-app browser closes on the return. */
export type BillingClient = "mobile" | undefined;

/** Product-side billing: access rules, checkout, and pull-based sync from the provider. */
export interface BillingService {
  readonly modelCreditsEnabled: boolean;
  readonly referralsEnabled: boolean;
  status(actor: Actor): Promise<BillingStatus>;
  selectFunding(
    actor: Actor,
    funding: "byok" | "credits",
    client?: BillingClient,
  ): Promise<{ ok: true; url?: string }>;
  purchaseCredits(
    actor: Actor,
    input: { amountCents: number; monthly: boolean; client?: BillingClient },
  ): Promise<{ url: string }>;
  setMonthlyCredits(actor: Actor, amountCents: number): Promise<{ ok: true }>;
  checkout(actor: Actor, client?: BillingClient): Promise<{ url: string }>;
  portal(actor: Actor, client?: BillingClient): Promise<{ url: string }>;
  /** Re-fetches the customer's subscription from the provider and overwrites the stored snapshot. */
  sync(customerId: string): Promise<void>;
  /** Syncs the actor's organization, e.g. on return from checkout before the webhook lands. */
  syncForActor(actor: Actor): Promise<void>;
  /** Pushes the organization's member count to the provider. Call when members change. */
  syncSeats(organizationId: string): Promise<void>;
  cancelForDeletedUser(userId: string): Promise<void>;
  claimReferral(actor: Actor, code: string): Promise<void>;
}

/**
 * Only the own-key plan has a trial: credits are resold at cost. An organization that has
 * subscribed before, or was given a free own-key period, has had its trial.
 */
function byokTrialAvailable(
  account: { subscribedAt: Date | null } | null,
  credits: { byokFreeUntil: Date | null },
) {
  return !account?.subscribedAt && !credits.byokFreeUntil;
}

export function createBillingService(deps: {
  prisma: PrismaClient;
  provider: BillingProvider;
  /** Prices computer time for the monthly allowance; without it none is shown. */
  sandbox?: SandboxProvider;
  managedModelsAvailable?: boolean;
  /** The session cookie lives on the web origin, which also proxies /api to this server. */
  webOrigin: string;
}): BillingService {
  const { prisma, provider } = deps;
  const appUrl = `${deps.webOrigin}/app`;
  const returnUrl = `${deps.webOrigin}${BILLING_RETURN_PATH}`;
  /** A mobile checkout returns through the API either way, which hands back to the app. */
  const mobileReturnUrl = `${returnUrl}?client=mobile`;
  const modelCredits = provider.describe().capabilities.modelCredits === true;
  const referrals = createReferrals(deps);
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
    const previous = await prisma.billingAccount.findUnique({ where: { customerId } });
    // Assigned in the callback, which control-flow narrowing does not follow.
    let snapshot = null as BillingSubscriptionSnapshot | null;
    const written = await syncBillingSnapshot(prisma, customerId, async () => {
      snapshot = await provider.getCustomerSubscription(customerId);
      return snapshot;
    });
    if (!written || !previous) {
      getLogger().warn("billing sync for unknown customer", { "billing.customer_id": customerId });
      return;
    }
    const live = snapshot;
    if (live && hasBillingAccess(live.status))
      await referrals.settle(previous.organizationId, live.cardFingerprint);
    if (!modelCredits || !live) return;
    // A newly paid own-key plan becomes the funding, wherever its checkout returned.
    if (
      live.byokPlan &&
      hasBillingAccess(live.status) &&
      live.subscriptionId !== previous.subscriptionId
    )
      // Only while this snapshot is still the stored one: a newer sync's write wins.
      await prisma.modelCreditAccount.updateMany({
        where: {
          organizationId: previous.organizationId,
          organization: { billing: { subscriptionId: live.subscriptionId } },
        },
        data: { mode: "byok", pendingCreditCheckout: false },
      });
    // Monthly credits include the own-key plan, even when they will not renew, and a free plan
    // bills nothing.
    if (
      provider.endByokPlans &&
      hasBillingAccess(live.status) &&
      (live.creditAmountCents ||
        (BYOK_MONTHLY_PRICE_CENTS === null && live.byokPlan && !live.cancelAtPeriodEnd))
    )
      await provider.endByokPlans(customerId);
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

  /** Opens a checkout; with `serialize`, one per organization at a time across API instances. */
  async function openCheckout(
    actor: Actor,
    account: BillingAccount,
    serialize: boolean,
    call: (customerId: string) => Promise<{ url: string }>,
  ) {
    if (!serialize) return withLiveCustomer(actor, account, call);
    // Opening another recurring checkout expires the old one.
    const { organizationId } = account;
    const deadline = Date.now() + CHECKOUT_LEASE_MS;
    let leaseId = await claimCheckoutLease(prisma, organizationId, CHECKOUT_LEASE_MS);
    while (!leaseId) {
      if (Date.now() > deadline) throw new ORPCError("CONFLICT");
      await sleep(CHECKOUT_LEASE_POLL_MS);
      leaseId = await claimCheckoutLease(prisma, organizationId, CHECKOUT_LEASE_MS);
    }
    try {
      return await withLiveCustomer(actor, account, call);
    } finally {
      await releaseCheckoutLease(prisma, organizationId, leaseId);
    }
  }

  async function billingAccountFor(actor: Actor, organizationId: string) {
    return (
      (await billingAccountForOrganization(prisma, organizationId)) ??
      createBillingAccount(prisma, {
        organizationId,
        customerId: await newCustomer(actor, organizationId),
      })
    );
  }

  async function byokCheckout(actor: Actor, organizationId: string, client: BillingClient) {
    const amountCents = BYOK_MONTHLY_PRICE_CENTS;
    if (amountCents === null || !provider.createByokCheckout) throw new ORPCError("NOT_FOUND");
    const [account, credits] = await Promise.all([
      billingAccountFor(actor, organizationId),
      creditAccount(prisma, organizationId),
    ]);
    try {
      return await openCheckout(actor, account, true, (customerId) =>
        provider.createByokCheckout!({
          customerId,
          amountCents,
          ...(byokTrialAvailable(account, credits) ? { trialDays: TRIAL_DAYS } : {}),
          successUrl: client === "mobile" ? mobileReturnUrl : returnUrl,
          cancelUrl: client === "mobile" ? mobileReturnUrl : appUrl,
        }),
      );
    } catch (error) {
      if (!(error instanceof BillingCheckoutCompletedError)) throw error;
      await sync(account.customerId);
      throw new ORPCError("CONFLICT", { message: "Manage your existing subscription in Billing" });
    }
  }

  return {
    modelCreditsEnabled: modelCredits,
    referralsEnabled: referrals.enabled,
    async selectFunding(actor, funding, client) {
      const { organizationId } = await managedOrganization(actor);
      const account = await creditAccount(prisma, organizationId);
      const subscription = await billingAccountForOrganization(prisma, organizationId);
      if (
        funding === "byok" &&
        subscription?.creditAmountCents &&
        !subscription.cancelAtPeriodEnd &&
        !["canceled", "incomplete_expired"].includes(subscription.status ?? "")
      )
        throw new ORPCError("CONFLICT", {
          message: "Cancel monthly credits in Billing before switching to your API key.",
        });
      // An unpaid own-key choice keeps the current funding until checkout completes.
      if (
        funding === "byok" &&
        !hasModelAccess({ ...account, mode: "byok" }, subscription?.status ?? null)
      )
        return { ok: true, ...(await byokCheckout(actor, organizationId, client)) };
      await prisma.modelCreditAccount.update({
        where: { organizationId },
        data: {
          mode: funding === "byok" ? "byok" : account.balanceMicros > 0n ? "credits" : null,
          pendingCreditCheckout: false,
        },
      });
      return { ok: true };
    },

    async purchaseCredits(actor, { client, ...input }) {
      if (!modelCredits || !provider.createCreditCheckout) throw new ORPCError("NOT_FOUND");
      if (deps.managedModelsAvailable === false) throw new ORPCError("PRECONDITION_FAILED");
      const { organizationId } = await managedOrganization(actor);
      const account = await billingAccountFor(actor, organizationId);
      await creditAccount(prisma, organizationId);
      try {
        const checkout = await openCheckout(actor, account, input.monthly, (customerId) =>
          provider.createCreditCheckout!({
            customerId,
            ...input,
            successUrl: client === "mobile" ? mobileReturnUrl : returnUrl,
            cancelUrl: client === "mobile" ? mobileReturnUrl : `${appUrl}?billing=canceled`,
          }),
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
      try {
        await provider.setMonthlyCredits(account.customerId, amountCents);
      } catch (error) {
        if (!(error instanceof BillingNoMonthlyCreditsError)) throw error;
        // The plan ended after the page loaded; syncing lets the next status offer Subscribe.
        await sync(account.customerId);
        throw new ORPCError("CONFLICT", { message: error.message, cause: error });
      }
      await sync(account.customerId);
      return { ok: true };
    },

    async status(actor) {
      if (modelCredits) {
        const { organizationId, isOwner } = await organization(actor);
        await expireModelCredits(prisma, organizationId);
        const [credits, account, computerAllowance] = await Promise.all([
          creditAccount(prisma, organizationId),
          billingAccountForOrganization(prisma, organizationId),
          deps.sandbox ? sandboxAllowance({ prisma, sandbox: deps.sandbox }, organizationId) : null,
        ]);
        const freeUntil =
          credits.mode === "byok" &&
          BYOK_MONTHLY_PRICE_CENTS !== null &&
          !hasBillingAccess(account?.status ?? null)
            ? byokFreeUntil(credits)
            : null;
        return {
          access: hasModelAccess(credits, account?.status ?? null),
          funding:
            credits.mode === "byok"
              ? "byok"
              : credits.balanceMicros > 0n || credits.mode === "credits"
                ? "credits"
                : null,
          balanceUsd: Number(credits.balanceMicros) / MICROS_PER_DOLLAR,
          monthlyAmountCents: account?.creditAmountCents ?? null,
          creditPurchasesEnabled: deps.managedModelsAvailable ?? true,
          byokPriceCents: BYOK_MONTHLY_PRICE_CENTS,
          byokFreeUntil: freeUntil?.toISOString() ?? null,
          canManage: isOwner,
          trialAvailable: BYOK_MONTHLY_PRICE_CENTS !== null && byokTrialAvailable(account, credits),
          trialDays: TRIAL_DAYS,
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
          trialEndsAt: account?.trialEndsAt?.toISOString() ?? null,
          currentPeriodEndsAt: account?.currentPeriodEndsAt?.toISOString() ?? null,
          cancelAtPeriodEnd: account?.cancelAtPeriodEnd ?? false,
          hasCustomer: Boolean(account),
          computerHoursLeft: computerAllowance && sandboxHoursLeft(computerAllowance),
          referral: await referrals.status(organizationId, isOwner),
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

    async checkout(actor, client) {
      const { organizationId } = await managedOrganization(actor);
      if (modelCredits) return byokCheckout(actor, organizationId, client);
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
            successUrl: client === "mobile" ? mobileReturnUrl : returnUrl,
            cancelUrl: client === "mobile" ? mobileReturnUrl : appUrl,
          }),
        );
      } catch (error) {
        if (!(error instanceof BillingCheckoutCompletedError)) throw error;
        await sync(account.customerId);
        throw new ORPCError("CONFLICT", { message: "Already subscribed" });
      }
    },

    async portal(actor, client) {
      const { organizationId } = await managedOrganization(actor);
      const account = await billingAccountForOrganization(prisma, organizationId);
      if (!account) throw new ORPCError("NOT_FOUND", { message: "No billing account" });
      return withLiveCustomer(actor, account, (customerId) =>
        provider.createPortal({
          customerId,
          returnUrl: client === "mobile" ? mobileReturnUrl : appUrl,
        }),
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

    async claimReferral(actor, code) {
      const { organizationId, isOwner } = await organization(actor);
      if (isOwner) await referrals.claim(organizationId, code);
    },

    async cancelForDeletedUser(userId) {
      for (const account of await ownedBillingAccounts(prisma, userId)) {
        await provider.cancelCustomerSubscriptions(account.customerId);
        await sync(account.customerId);
      }
    },
  };
}
