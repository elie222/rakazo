import { describe, expect, it } from "vitest";
import {
  encodeStripeForm,
  mapStripeSubscriptionStatus,
  parseStripeWebhook,
  STRIPE_API_VERSION,
  StripeBillingProvider,
  signStripeWebhook,
  stripeBillingConfigFromEnv,
} from "./stripe-billing.js";
import { StripeEmulator } from "./testing/stripe-emulator.js";

function setup() {
  const wire = new StripeEmulator();
  const provider = new StripeBillingProvider({
    secretKey: wire.secretKey,
    webhookSecret: "whsec_fake",
    priceId: wire.priceId,
    fetch: wire.fetch,
  });
  return { wire, provider };
}

const urls = { successUrl: "https://app.example/ok", cancelUrl: "https://app.example/no" };

describe("Stripe billing HTTP boundary", () => {
  it("encodes nested form keys and omits undefined values", () => {
    expect(
      decodeURIComponent(
        encodeStripeForm({ a: [{ price: "p", quantity: 2 }], b: { c: undefined }, d: true }),
      ),
    ).toBe("a[0][price]=p&a[0][quantity]=2&d=true");
  });

  it("sends the checkout shape with a fresh session per attempt and pinned version", async () => {
    const { wire, provider } = setup();
    const { customerId } = await provider.createCustomer({
      email: "owner@example.com",
      organizationId: "org_1",
    });
    const customerRequest = wire.requests.at(-1)!;
    expect(customerRequest.headers.get("idempotency-key")).toBe("customer:org_1");
    expect(customerRequest.form["metadata[organization_id]"]).toBe("org_1");

    await provider.createCheckout({ customerId, seats: 4, ...urls });
    const plain = wire.requests.at(-1)!;
    expect(plain.headers.get("stripe-version")).toBe(STRIPE_API_VERSION);
    expect(plain.headers.get("content-type")).toBe("application/x-www-form-urlencoded");
    expect(plain.form).toMatchObject({
      mode: "subscription",
      customer: customerId,
      "line_items[0][price]": wire.priceId,
      "line_items[0][quantity]": "4",
      payment_method_collection: "always",
      allow_promotion_codes: "true",
      success_url: urls.successUrl,
      cancel_url: urls.cancelUrl,
    });
    expect(plain.form).not.toHaveProperty("subscription_data[trial_period_days]");
    expect(plain.headers.get("idempotency-key")).toBeNull();

    await provider.createCheckout({ customerId, seats: 4, trialDays: 14, ...urls });
    expect(wire.requests.at(-1)!.form["subscription_data[trial_period_days]"]).toBe("14");
  });

  it("expires unfinished checkouts, including past the first page, and leaves a paid one", async () => {
    const { wire, provider } = setup();
    wire.pageSize = 1;
    const { customerId } = await provider.createCustomer({
      email: "owner@example.com",
      organizationId: "org_1",
    });
    for (const id of ["cs_old_1", "cs_old_2", "cs_old_3"]) {
      wire.sessions.push({
        id,
        customer: customerId,
        status: "open",
        form: { "line_items[0][price]": wire.priceId, "line_items[0][quantity]": "1" },
      });
    }
    const opened = await provider.createCheckout({ customerId, seats: 4, ...urls });
    expect(
      wire.sessions.filter((session) => session.status === "expired").map((s) => s.id),
    ).toEqual(["cs_old_1", "cs_old_2", "cs_old_3"]);
    const open = wire.sessions.filter((session) => session.status === "open");
    expect(open).toHaveLength(1);
    expect(opened.url).toBe(`https://checkout.stripe.com/c/pay/${open[0]!.id}`);
    wire.completeCheckout(customerId);
    expect(wire.subscriptions).toHaveLength(1);
    expect(wire.subscriptions[0]!.items.data[0]!.quantity).toBe(4);
    expect(() => wire.completeCheckout(customerId)).toThrow(/open checkout/);

    await provider.createCheckout({ customerId, seats: 1, ...urls });
    expect(wire.requests.filter((request) => request.path.endsWith("/expire"))).toHaveLength(3);
    expect(wire.sessions.filter((session) => session.status === "complete")).toHaveLength(1);
  });

  it("reads every page of subscriptions", async () => {
    const { wire, provider } = setup();
    wire.pageSize = 2;
    const { customerId } = await provider.createCustomer({
      email: "owner@example.com",
      organizationId: "org_1",
    });
    for (const status of ["active", "canceled", "canceled", "canceled", "incomplete"]) {
      await provider.createCheckout({ customerId, seats: 1, ...urls });
      wire.completeCheckout(customerId, status);
    }
    await expect(provider.getCustomerSubscription(customerId)).resolves.toMatchObject({
      status: "active",
    });
    await provider.cancelCustomerSubscriptions(customerId);
    expect(wire.subscriptions.every((s) => s.status === "canceled")).toBe(true);
  });

  it("cancels unpaid and paused subscriptions, which can still resume", async () => {
    const { wire, provider } = setup();
    const { customerId } = await provider.createCustomer({
      email: "owner@example.com",
      organizationId: "org_1",
    });
    for (const status of ["unpaid", "paused"]) {
      await provider.createCheckout({ customerId, seats: 1, ...urls });
      wire.completeCheckout(customerId, status);
    }
    await provider.cancelCustomerSubscriptions(customerId);
    expect(wire.subscriptions.map((s) => s.status)).toEqual(["canceled", "canceled"]);
  });

  it("maps Stripe statuses onto the neutral set", () => {
    for (const status of ["trialing", "active", "past_due", "incomplete"])
      expect(mapStripeSubscriptionStatus(status)).toBe(status);
    for (const status of ["canceled", "unpaid", "paused", "incomplete_expired"])
      expect(mapStripeSubscriptionStatus(status)).toBe("canceled");
  });

  it("treats a scheduled cancellation as cancel at period end", async () => {
    const { wire, provider } = setup();
    const { customerId } = await provider.createCustomer({
      email: "owner@example.com",
      organizationId: "org_1",
    });
    await provider.createCheckout({ customerId, seats: 1, ...urls });
    wire.completeCheckout(customerId);
    wire.subscriptions[0]!.cancel_at = 1_900_000_000;
    wire.setStatus(customerId, "unpaid");
    expect(await provider.getCustomerSubscription(customerId)).toMatchObject({
      status: "canceled",
      cancelAtPeriodEnd: true,
    });
  });

  it("surfaces Stripe's error message without the secret key", async () => {
    const { wire, provider } = setup();
    wire.failNext = { status: 400, message: `Bad key ${wire.secretKey} rejected` };
    const error = await provider.getPrice().then(
      () => new Error("expected failure"),
      (e: Error) => e,
    );
    expect(error.message).toBe("Stripe request failed (400): Bad key [redacted] rejected");
    expect(error.message).not.toContain(wire.secretKey);
  });

  it("accepts any matching v1 signature and ignores malformed JSON", () => {
    const now = Date.UTC(2026, 0, 1);
    const t = now / 1000;
    const body = "not json";
    const valid = signStripeWebhook("whsec_fake", body, t).split(",")[1];
    const headers = new Headers({ "stripe-signature": `t=${t},v1=deadbeef,${valid}` });
    expect(parseStripeWebhook("whsec_fake", body, headers, now)).toBe("ignored");
    expect(parseStripeWebhook("whsec_other", body, headers, now)).toBeNull();
  });
});

describe("stripeBillingConfigFromEnv", () => {
  it("is disabled when unset and complete when all are set", () => {
    expect(stripeBillingConfigFromEnv({})).toBeUndefined();
    expect(
      stripeBillingConfigFromEnv({
        stripeSecretKey: "sk_test_fake",
        stripeWebhookSecret: "whsec_fake",
        stripePriceId: "price_fake",
      }),
    ).toEqual({ secretKey: "sk_test_fake", webhookSecret: "whsec_fake", priceId: "price_fake" });
  });

  it("names the missing variables when partially configured", () => {
    expect(() => stripeBillingConfigFromEnv({ stripeSecretKey: "sk_test_fake" })).toThrow(
      "STRIPE_WEBHOOK_SECRET, STRIPE_PRICE_ID",
    );
  });
});
