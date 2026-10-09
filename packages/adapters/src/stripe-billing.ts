import { createHmac, timingSafeEqual } from "node:crypto";
import type {
  BillingCheckoutRequest,
  BillingPrice,
  BillingProvider,
  BillingSubscriptionSnapshot,
  BillingSubscriptionStatus,
} from "@rakazo/adapter-kit";
import { z } from "zod";

export const STRIPE_API_VERSION = "2025-08-27.basil";
const WEBHOOK_TOLERANCE_SECONDS = 300;

export interface StripeBillingConfig {
  secretKey: string;
  webhookSecret: string;
  priceId: string;
  fetch?: typeof fetch;
  apiBase?: string;
  now?: () => number;
}

const priceSchema = z.object({
  unit_amount: z.number().int(),
  currency: z.string(),
  recurring: z.object({
    interval: z.enum(["day", "week", "month", "year"]),
    interval_count: z.number().int(),
  }),
});
const idSchema = z.object({ id: z.string().min(1) });
const urlSchema = z.object({ url: z.string().min(1) });
const subscriptionSchema = z.object({
  id: z.string(),
  status: z.string(),
  created: z.number(),
  trial_end: z.number().nullish(),
  current_period_end: z.number().nullish(),
  cancel_at_period_end: z.boolean().nullish(),
  cancel_at: z.number().nullish(),
  ended_at: z.number().nullish(),
  items: z.object({
    data: z.array(
      z.object({
        id: z.string(),
        quantity: z.number().int().nullish(),
        current_period_end: z.number().nullish(),
        price: idSchema,
      }),
    ),
  }),
});
const subscriptionListSchema = z.object({
  data: z.array(subscriptionSchema),
  has_more: z.boolean(),
});
const checkoutListSchema = z.object({
  data: z.array(z.object({ id: z.string().min(1) })),
  has_more: z.boolean(),
});
type StripeSubscription = z.infer<typeof subscriptionSchema>;

/** Stripe REST wire format and credentials stay inside this adapter. */
export class StripeBillingProvider implements BillingProvider {
  private readonly config: StripeBillingConfig;
  private readonly fetchImpl: typeof fetch;
  private readonly apiBase: string;
  private readonly now: () => number;

  constructor(config: StripeBillingConfig) {
    this.config = config;
    this.fetchImpl = config.fetch ?? fetch;
    this.apiBase = config.apiBase ?? "https://api.stripe.com";
    this.now = config.now ?? Date.now;
  }

  describe() {
    return {
      id: "stripe",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { trials: true, portal: true },
    };
  }

  async getPrice(): Promise<BillingPrice> {
    const price = priceSchema.parse(
      await this.request("GET", `/v1/prices/${encodeURIComponent(this.config.priceId)}`),
    );
    return {
      amount: price.unit_amount,
      currency: price.currency,
      interval: price.recurring.interval,
      intervalCount: price.recurring.interval_count,
    };
  }

  async createCustomer(input: { email: string; organizationId: string }) {
    const customer = idSchema.parse(
      await this.request(
        "POST",
        "/v1/customers",
        { email: input.email, metadata: { organization_id: input.organizationId } },
        `customer:${input.organizationId}`,
      ),
    );
    return { customerId: customer.id };
  }

  async createCheckout(input: BillingCheckoutRequest) {
    // An abandoned session has no subscription yet, so the access check still passes.
    // Expire it before opening another; a completed session is not open and stays paid once.
    await this.expireOpenCheckouts(input.customerId);
    const body = encodeStripeForm({
      mode: "subscription",
      customer: input.customerId,
      line_items: [{ price: this.config.priceId, quantity: input.seats }],
      payment_method_collection: "always",
      allow_promotion_codes: true,
      subscription_data:
        input.trialDays === undefined ? undefined : { trial_period_days: input.trialDays },
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
    });
    // No idempotency key: identical params from a later attempt must get a fresh session.
    const session = urlSchema.parse(await this.request("POST", "/v1/checkout/sessions", body));
    return { url: session.url };
  }

  async createPortal(input: { customerId: string; returnUrl: string }) {
    const session = urlSchema.parse(
      await this.request("POST", "/v1/billing_portal/sessions", {
        customer: input.customerId,
        return_url: input.returnUrl,
      }),
    );
    return { url: session.url };
  }

  async getCustomerSubscription(customerId: string): Promise<BillingSubscriptionSnapshot | null> {
    const subscriptions = (await this.listSubscriptions(customerId)).map((subscription) => ({
      subscription,
      status: mapStripeSubscriptionStatus(subscription.status),
      created: subscription.created,
    }));
    const chosen = pickBillingSubscription(subscriptions);
    return chosen ? toSnapshot(chosen.subscription, chosen.status) : null;
  }

  async updateSeats(subscriptionItemId: string, seats: number) {
    await this.request("POST", `/v1/subscription_items/${encodeURIComponent(subscriptionItemId)}`, {
      quantity: seats,
      proration_behavior: "create_prorations",
    });
  }

  async cancelCustomerSubscriptions(customerId: string) {
    for (const subscription of await this.listSubscriptions(customerId)) {
      // Only terminal states; unpaid and paused subscriptions can still resume and charge.
      if (subscription.status === "canceled" || subscription.status === "incomplete_expired")
        continue;
      await this.request("DELETE", `/v1/subscriptions/${encodeURIComponent(subscription.id)}`);
    }
  }

  parseWebhook(rawBody: string, headers: Headers) {
    return parseStripeWebhook(this.config.webhookSecret, rawBody, headers, this.now());
  }

  private async expireOpenCheckouts(customerId: string): Promise<void> {
    const seen = new Set<string>();
    for (;;) {
      const query = encodeStripeForm({ customer: customerId, status: "open", limit: 100 });
      const page = checkoutListSchema.parse(
        await this.request("GET", `/v1/checkout/sessions?${query}`),
      );
      const fresh = page.data.filter((session) => !seen.has(session.id));
      if (fresh.length === 0) return;
      for (const session of fresh) {
        seen.add(session.id);
        await this.request(
          "POST",
          `/v1/checkout/sessions/${encodeURIComponent(session.id)}/expire`,
        );
      }
    }
  }

  private async listSubscriptions(customerId: string): Promise<StripeSubscription[]> {
    const all: StripeSubscription[] = [];
    let startingAfter: string | undefined;
    for (;;) {
      const query = encodeStripeForm({
        customer: customerId,
        status: "all",
        limit: 100,
        starting_after: startingAfter,
      });
      const page = subscriptionListSchema.parse(
        await this.request("GET", `/v1/subscriptions?${query}`),
      );
      all.push(...page.data);
      const last = page.data.at(-1);
      if (!page.has_more || !last) return all;
      startingAfter = last.id;
    }
  }

  private async request(
    method: "GET" | "POST" | "DELETE",
    path: string,
    params?: Record<string, unknown> | string,
    idempotencyKey?: string,
  ): Promise<unknown> {
    const body = typeof params === "string" ? params : params && encodeStripeForm(params);
    const response = await this.fetchImpl(`${this.apiBase}${path}`, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
      headers: {
        Authorization: `Bearer ${this.config.secretKey}`,
        "Stripe-Version": STRIPE_API_VERSION,
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/x-www-form-urlencoded" }),
        ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
      },
      body,
    });
    const json: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      const message = z
        .object({ error: z.object({ message: z.string() }) })
        .safeParse(json)
        .data?.error.message.replaceAll(this.config.secretKey, "[redacted]");
      throw new Error(`Stripe request failed (${response.status})${message ? `: ${message}` : ""}`);
    }
    if (json === undefined) throw new Error("Invalid Stripe response");
    return json;
  }
}

/** Stripe statuses collapse onto the provider-neutral set. */
export function mapStripeSubscriptionStatus(status: string): BillingSubscriptionStatus {
  if (
    status === "trialing" ||
    status === "active" ||
    status === "past_due" ||
    status === "incomplete"
  )
    return status;
  return "canceled";
}

/** Prefers the newest subscription that grants access, else the newest overall. */
export function pickBillingSubscription<
  T extends { status: BillingSubscriptionStatus; created: number },
>(subscriptions: T[]): T | undefined {
  const newestFirst = [...subscriptions].sort((a, b) => b.created - a.created);
  return (
    newestFirst.find((s) => ["trialing", "active", "past_due"].includes(s.status)) ?? newestFirst[0]
  );
}

function toSnapshot(
  subscription: StripeSubscription,
  status: BillingSubscriptionStatus,
): BillingSubscriptionSnapshot {
  const item = subscription.items.data[0];
  if (!item) throw new Error("Stripe subscription has no items");
  return {
    subscriptionId: subscription.id,
    subscriptionItemId: item.id,
    priceId: item.price.id,
    status,
    seats: item.quantity ?? 1,
    trialEndsAt: fromSeconds(subscription.trial_end),
    currentPeriodEndsAt: fromSeconds(item.current_period_end ?? subscription.current_period_end),
    cancelAtPeriodEnd: Boolean(subscription.cancel_at_period_end) || subscription.cancel_at != null,
    endedAt: fromSeconds(subscription.ended_at),
  };
}

function fromSeconds(value: number | null | undefined) {
  return value == null ? null : new Date(value * 1000);
}

/** Stripe's bracketed form encoding: `line_items[0][price]=...`. Undefined values are omitted. */
export function encodeStripeForm(params: Record<string, unknown>): string {
  const form = new URLSearchParams();
  const append = (key: string, value: unknown) => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) {
      for (const [i, entry] of value.entries()) append(`${key}[${i}]`, entry);
    } else if (typeof value === "object")
      for (const [k, v] of Object.entries(value)) append(`${key}[${k}]`, v);
    else form.append(key, String(value));
  };
  for (const [key, value] of Object.entries(params)) append(key, value);
  return form.toString();
}

/** `stripe-signature` header value for `body` at `timestamp` (seconds). */
export function signStripeWebhook(secret: string, body: string, timestamp: number): string {
  const signature = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  return `t=${timestamp},v1=${signature}`;
}

const syncEventTypes = new Set([
  "checkout.session.completed",
  "invoice.paid",
  "invoice.payment_failed",
]);

/** Verifies a Stripe-signed webhook and extracts the customer to re-sync. */
export function parseStripeWebhook(
  secret: string,
  rawBody: string,
  headers: Headers,
  nowMs: number,
): { customerId: string } | "ignored" | null {
  const parts = (headers.get("stripe-signature") ?? "").split(",").map((part) => part.split("="));
  const timestamp = Number(parts.find(([key]) => key === "t")?.[1]);
  if (!Number.isFinite(timestamp)) return null;
  if (Math.abs(nowMs / 1000 - timestamp) > WEBHOOK_TOLERANCE_SECONDS) return null;
  const expected = Buffer.from(
    createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex"),
  );
  const valid = parts.some(([key, value]) => {
    if (key !== "v1" || !value) return false;
    const candidate = Buffer.from(value);
    return candidate.length === expected.length && timingSafeEqual(candidate, expected);
  });
  if (!valid) return null;

  let event: { type?: unknown; data?: { object?: Record<string, unknown> } };
  try {
    event = JSON.parse(rawBody);
  } catch {
    return "ignored";
  }
  const type = typeof event?.type === "string" ? event.type : "";
  if (!syncEventTypes.has(type) && !type.startsWith("customer.subscription.")) return "ignored";
  const object = event.data?.object;
  const customer = object?.object === "customer" ? object.id : object?.customer;
  const customerId =
    typeof customer === "string"
      ? customer
      : typeof (customer as { id?: unknown } | undefined)?.id === "string"
        ? (customer as { id: string }).id
        : undefined;
  return customerId ? { customerId } : "ignored";
}

export function stripeBillingConfigFromEnv(env: {
  stripeSecretKey?: string;
  stripeWebhookSecret?: string;
  stripePriceId?: string;
}): StripeBillingConfig | undefined {
  const values = {
    STRIPE_SECRET_KEY: env.stripeSecretKey?.trim(),
    STRIPE_WEBHOOK_SECRET: env.stripeWebhookSecret?.trim(),
    STRIPE_PRICE_ID: env.stripePriceId?.trim(),
  };
  const missing = Object.entries(values)
    .filter(([, value]) => !value)
    .map(([name]) => name);
  if (missing.length === 3) return undefined;
  if (missing.length)
    throw new Error(`Stripe billing is partially configured; set ${missing.join(", ")}`);
  return {
    secretKey: values.STRIPE_SECRET_KEY!,
    webhookSecret: values.STRIPE_WEBHOOK_SECRET!,
    priceId: values.STRIPE_PRICE_ID!,
  };
}
