import type {
  BillingCheckoutRequest,
  BillingPrice,
  BillingProvider,
  BillingSubscriptionSnapshot,
  BillingSubscriptionStatus,
} from "@rakazo/adapter-kit";
import {
  parseStripeWebhook,
  pickBillingSubscription,
  signStripeWebhook,
} from "./stripe-billing.js";

const WEBHOOK_SECRET = "billing-emulator-webhook-secret";

export interface BillingEmulatorOptions {
  price?: BillingPrice;
  now?: () => number;
}

type EmulatedSubscription = BillingSubscriptionSnapshot & { customerId: string; created: number };

/** Offline, deterministic billing provider for development and tests. */
export class BillingEmulator implements BillingProvider {
  readonly price: BillingPrice;
  readonly customers = new Map<string, { email: string; organizationId: string }>();
  readonly checkouts = new Map<string, BillingCheckoutRequest>();
  readonly subscriptions: EmulatedSubscription[] = [];
  private readonly now: () => number;
  private sequence = 0;

  constructor(options: BillingEmulatorOptions = {}) {
    this.price = options.price ?? {
      amount: 1000,
      currency: "usd",
      interval: "month",
      intervalCount: 1,
    };
    this.now = options.now ?? Date.now;
  }

  describe() {
    return {
      id: "billing-emulator",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { trials: true, portal: true },
    };
  }

  async getPrice() {
    return { ...this.price };
  }

  async createCustomer(input: { email: string; organizationId: string }) {
    for (const [customerId, customer] of this.customers)
      if (customer.organizationId === input.organizationId) return { customerId };
    const customerId = `cus_emulated_${this.customers.size + 1}`;
    this.customers.set(customerId, { ...input });
    return { customerId };
  }

  async createCheckout(input: BillingCheckoutRequest) {
    this.requireCustomer(input.customerId);
    this.checkouts.set(input.customerId, { ...input });
    return { url: `https://billing.emulator.invalid/checkout/${input.customerId}` };
  }

  async createPortal(input: { customerId: string; returnUrl: string }) {
    this.requireCustomer(input.customerId);
    return { url: `https://billing.emulator.invalid/portal/${input.customerId}` };
  }

  async getCustomerSubscription(customerId: string) {
    const chosen = pickBillingSubscription(this.forCustomer(customerId));
    if (!chosen) return null;
    const { customerId: _customer, created: _created, ...snapshot } = chosen;
    return { ...snapshot };
  }

  async updateSeats(subscriptionItemId: string, seats: number) {
    const subscription = this.subscriptions.find(
      (s) => s.subscriptionItemId === subscriptionItemId,
    );
    if (!subscription) throw new Error(`Unknown subscription item ${subscriptionItemId}`);
    subscription.seats = seats;
  }

  async cancelCustomerSubscriptions(customerId: string) {
    for (const subscription of this.forCustomer(customerId)) {
      if (subscription.status === "canceled") continue;
      subscription.status = "canceled";
      subscription.endedAt = new Date(this.now());
    }
  }

  parseWebhook(rawBody: string, headers: Headers) {
    return parseStripeWebhook(WEBHOOK_SECRET, rawBody, headers, this.now());
  }

  /** Test helper: the customer finishes the last checkout they started. */
  completeCheckout(customerId: string, status?: BillingSubscriptionStatus) {
    const checkout = this.checkouts.get(customerId);
    if (!checkout) throw new Error(`No checkout for ${customerId}`);
    const n = ++this.sequence;
    const nowSeconds = Math.floor(this.now() / 1000);
    const trialEnd = checkout.trialDays ? nowSeconds + checkout.trialDays * 86_400 : null;
    this.subscriptions.push({
      customerId,
      created: nowSeconds + n,
      subscriptionId: `sub_emulated_${n}`,
      subscriptionItemId: `si_emulated_${n}`,
      priceId: "price_emulated",
      status: status ?? (trialEnd ? "trialing" : "active"),
      seats: checkout.seats,
      trialEndsAt: trialEnd === null ? null : new Date(trialEnd * 1000),
      currentPeriodEndsAt: new Date((trialEnd ?? nowSeconds + 30 * 86_400) * 1000),
      cancelAtPeriodEnd: false,
      endedAt: null,
    });
    return `sub_emulated_${n}`;
  }

  /** Test helper: moves the customer's newest subscription to `status`. */
  setStatus(customerId: string, status: BillingSubscriptionStatus) {
    const newest = this.forCustomer(customerId).sort((a, b) => b.created - a.created)[0];
    if (!newest) throw new Error(`No subscription for ${customerId}`);
    newest.status = status;
  }

  /** Test helper: a webhook request this emulator's `parseWebhook` accepts. */
  signWebhook(event: object, timestamp = Math.floor(this.now() / 1000)) {
    const body = JSON.stringify(event);
    const headers = new Headers({
      "content-type": "application/json",
      "stripe-signature": signStripeWebhook(WEBHOOK_SECRET, body, timestamp),
    });
    return { body, headers };
  }

  private forCustomer(customerId: string) {
    return this.subscriptions.filter((s) => s.customerId === customerId);
  }

  private requireCustomer(customerId: string) {
    if (!this.customers.has(customerId)) throw new Error(`Unknown customer ${customerId}`);
  }
}
