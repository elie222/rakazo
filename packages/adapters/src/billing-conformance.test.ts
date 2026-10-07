import type { BillingProvider, BillingSubscriptionStatus } from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import { BillingEmulator } from "./billing-emulator.js";
import { StripeBillingProvider, signStripeWebhook } from "./stripe-billing.js";
import { StripeEmulator } from "./testing/stripe-emulator.js";

const NOW = Date.UTC(2026, 0, 1);
const now = () => NOW;

interface Harness {
  provider: BillingProvider;
  completeCheckout(customerId: string, status?: BillingSubscriptionStatus): void;
  sign(event: object, timestamp?: number): { body: string; headers: Headers };
}

const factories: Record<string, () => Harness> = {
  emulator() {
    const provider = new BillingEmulator({ now });
    return {
      provider,
      completeCheckout: (customerId, status) => provider.completeCheckout(customerId, status),
      sign: (event, timestamp) => provider.signWebhook(event, timestamp),
    };
  },
  "stripe-over-wire-emulator"() {
    const wire = new StripeEmulator({ now });
    const webhookSecret = "whsec_fake";
    const provider = new StripeBillingProvider({
      secretKey: wire.secretKey,
      webhookSecret,
      priceId: wire.priceId,
      fetch: wire.fetch,
      now,
    });
    return {
      provider,
      completeCheckout: (customerId, status) => wire.completeCheckout(customerId, status),
      sign(event, timestamp = Math.floor(NOW / 1000)) {
        const body = JSON.stringify(event);
        const headers = new Headers({
          "stripe-signature": signStripeWebhook(webhookSecret, body, timestamp),
        });
        return { body, headers };
      },
    };
  },
};

const urls = { successUrl: "https://app.example/ok", cancelUrl: "https://app.example/no" };

async function subscribe(harness: Harness, trialDays?: number) {
  const { customerId } = await harness.provider.createCustomer({
    email: "owner@example.com",
    organizationId: "org_1",
  });
  const checkout = await harness.provider.createCheckout({
    customerId,
    seats: 3,
    trialDays,
    ...urls,
  });
  expect(checkout.url).toMatch(/^https:\/\//);
  harness.completeCheckout(customerId);
  return customerId;
}

for (const [name, create] of Object.entries(factories)) {
  describe(`${name} billing conformance (offline)`, () => {
    it("describes a recurring price", async () => {
      const { provider } = create();
      expect(provider.describe().capabilities).toEqual({ trials: true, portal: true });
      const price = await provider.getPrice();
      expect(price.amount).toBeGreaterThan(0);
      expect(price.currency).toMatch(/^[a-z]{3}$/);
      expect(["day", "week", "month", "year"]).toContain(price.interval);
      expect(price.intervalCount).toBeGreaterThanOrEqual(1);
    });

    it("starts a trial with the purchased seats and re-syncs idempotently", async () => {
      const harness = create();
      const customerId = await subscribe(harness, 14);
      const snapshot = await harness.provider.getCustomerSubscription(customerId);
      expect(snapshot).toMatchObject({
        status: "trialing",
        seats: 3,
        cancelAtPeriodEnd: false,
        endedAt: null,
      });
      expect(snapshot?.trialEndsAt?.getTime()).toBe(NOW + 14 * 86_400_000);
      expect(snapshot?.currentPeriodEndsAt).toBeInstanceOf(Date);
      expect(await harness.provider.getCustomerSubscription(customerId)).toEqual(snapshot);
      expect(
        (await harness.provider.createPortal({ customerId, returnUrl: urls.successUrl })).url,
      ).toMatch(/^https:\/\//);
    });

    it("reuses the customer for the same organization", async () => {
      const { provider } = create();
      const input = { email: "owner@example.com", organizationId: "org_1" };
      expect((await provider.createCustomer(input)).customerId).toBe(
        (await provider.createCustomer(input)).customerId,
      );
    });

    it("replaces an unfinished checkout so only the latest one can be paid", async () => {
      const harness = create();
      const { customerId } = await harness.provider.createCustomer({
        email: "owner@example.com",
        organizationId: "org_3",
      });
      await harness.provider.createCheckout({ customerId, seats: 1, ...urls });
      await harness.provider.createCheckout({ customerId, seats: 4, trialDays: 14, ...urls });
      harness.completeCheckout(customerId);
      expect(await harness.provider.getCustomerSubscription(customerId)).toMatchObject({
        status: "trialing",
        seats: 4,
      });
    });

    it("is active immediately without a trial and returns null before any subscription", async () => {
      const harness = create();
      const { customerId } = await harness.provider.createCustomer({
        email: "owner@example.com",
        organizationId: "org_2",
      });
      expect(await harness.provider.getCustomerSubscription(customerId)).toBeNull();
      await harness.provider.createCheckout({ customerId, seats: 2, ...urls });
      harness.completeCheckout(customerId);
      expect(await harness.provider.getCustomerSubscription(customerId)).toMatchObject({
        status: "active",
        seats: 2,
        trialEndsAt: null,
      });
    });

    it("prefers an older active subscription over a newer incomplete one", async () => {
      const harness = create();
      const customerId = await subscribe(harness);
      const active = await harness.provider.getCustomerSubscription(customerId);
      await harness.provider.createCheckout({ customerId, seats: 5, ...urls });
      harness.completeCheckout(customerId, "incomplete");
      expect(await harness.provider.getCustomerSubscription(customerId)).toEqual(active);
    });

    it("updates seats and cancels", async () => {
      const harness = create();
      const customerId = await subscribe(harness);
      const snapshot = await harness.provider.getCustomerSubscription(customerId);
      await harness.provider.updateSeats(snapshot!.subscriptionItemId, 7);
      expect((await harness.provider.getCustomerSubscription(customerId))?.seats).toBe(7);
      await harness.provider.cancelCustomerSubscriptions(customerId);
      const canceled = await harness.provider.getCustomerSubscription(customerId);
      expect(canceled?.status).toBe("canceled");
      expect(canceled?.endedAt).toBeInstanceOf(Date);
      await harness.provider.cancelCustomerSubscriptions(customerId);
    });

    it("verifies webhooks", () => {
      const { provider, sign } = create();
      const event = {
        type: "customer.subscription.updated",
        data: { object: { object: "subscription", customer: "cus_1" } },
      };
      const valid = sign(event);
      expect(provider.parseWebhook(valid.body, valid.headers)).toEqual({ customerId: "cus_1" });
      expect(provider.parseWebhook(valid.body.replace("cus_1", "cus_2"), valid.headers)).toBeNull();
      expect(provider.parseWebhook(valid.body, new Headers())).toBeNull();
      const stale = sign(event, Math.floor(NOW / 1000) - 301);
      expect(provider.parseWebhook(stale.body, stale.headers)).toBeNull();
      const checkout = sign({
        type: "checkout.session.completed",
        data: { object: { customer: { id: "cus_3" } } },
      });
      expect(provider.parseWebhook(checkout.body, checkout.headers)).toEqual({
        customerId: "cus_3",
      });
      const unrelated = sign({ type: "product.created", data: { object: { id: "prod_1" } } });
      expect(provider.parseWebhook(unrelated.body, unrelated.headers)).toBe("ignored");
    });
  });
}
