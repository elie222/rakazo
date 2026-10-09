/** In-process Stripe REST substitute covering exactly the endpoints the billing adapter uses. */
export class StripeEmulator {
  readonly secretKey = "sk_test_fake";
  readonly priceId = "price_fake";
  readonly requests: Array<{
    method: string;
    path: string;
    headers: Headers;
    form: Record<string, string>;
  }> = [];
  readonly customers = new Map<string, Record<string, unknown>>();
  readonly sessions: StripeCheckoutSession[] = [];
  readonly subscriptions: StripeSubscriptionRecord[] = [];
  /** Largest page the list endpoint returns; lower it to exercise pagination. */
  pageSize = 100;
  /** Next response fails with this Stripe error. */
  failNext: { status: number; message: string } | undefined;
  private readonly idempotent = new Map<string, unknown>();
  private sequence = 0;
  private readonly now: () => number;

  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.origin !== "https://api.stripe.com") throw new Error("Unexpected emulator origin");
    const headers = new Headers(init?.headers);
    if (headers.get("authorization") !== `Bearer ${this.secretKey}`)
      return stripeError(401, "Invalid API Key provided");
    const method = init?.method ?? "GET";
    const form = Object.fromEntries(
      new URLSearchParams(method === "GET" ? url.search : String(init?.body ?? "")),
    );
    this.requests.push({ method, path: url.pathname, headers, form });
    if (this.failNext) {
      const { status, message } = this.failNext;
      this.failNext = undefined;
      return stripeError(status, message);
    }
    const key = headers.get("idempotency-key");
    if (key && this.idempotent.has(key)) return Response.json(this.idempotent.get(key));
    const response = this.route(method, url.pathname, form);
    if (key && response.ok) this.idempotent.set(key, await response.clone().json());
    return response;
  };

  /** The customer finishes their open checkout. An expired session cannot be paid. */
  completeCheckout(customerId: string, status?: string) {
    const checkout = this.sessions.findLast(
      (session) => session.customer === customerId && session.status === "open",
    );
    if (!checkout) throw new Error(`No open checkout for ${customerId}`);
    checkout.status = "complete";
    const n = ++this.sequence;
    const nowSeconds = Math.floor(this.now() / 1000);
    const trialDays = checkout.form["subscription_data[trial_period_days]"];
    const trialEnd = trialDays ? nowSeconds + Number(trialDays) * 86_400 : null;
    this.subscriptions.push({
      id: `sub_fake_${n}`,
      object: "subscription",
      customer: customerId,
      status: status ?? (trialEnd ? "trialing" : "active"),
      created: nowSeconds + n,
      trial_end: trialEnd,
      cancel_at_period_end: false,
      cancel_at: null,
      ended_at: null,
      items: {
        object: "list",
        data: [
          {
            id: `si_fake_${n}`,
            object: "subscription_item",
            price: { id: checkout.form["line_items[0][price]"]!, object: "price" },
            quantity: Number(checkout.form["line_items[0][quantity]"]),
            current_period_end: trialEnd ?? nowSeconds + 30 * 86_400,
          },
        ],
      },
    });
    return `sub_fake_${n}`;
  }

  /** Moves the customer's newest subscription to a raw Stripe status. */
  setStatus(customerId: string, status: string) {
    const newest = this.forCustomer(customerId)[0];
    if (!newest) throw new Error(`No subscription for ${customerId}`);
    newest.status = status;
  }

  private route(method: string, path: string, form: Record<string, string>): Response {
    if (method === "GET" && path === `/v1/prices/${this.priceId}`)
      return Response.json({
        id: this.priceId,
        object: "price",
        unit_amount: 1000,
        currency: "usd",
        recurring: { interval: "month", interval_count: 1 },
      });
    if (method === "POST" && path === "/v1/customers") {
      const id = `cus_fake_${this.customers.size + 1}`;
      const customer = { id, object: "customer", email: form.email, metadata: {} };
      this.customers.set(id, customer);
      return Response.json(customer);
    }
    if (method === "POST" && path === "/v1/checkout/sessions") {
      const customer = form.customer ?? "";
      if (!this.customers.has(customer)) return stripeError(404, `No such customer: '${customer}'`);
      const id = `cs_fake_${++this.sequence}`;
      this.sessions.push({ id, customer, status: "open", form });
      return Response.json({
        id,
        object: "checkout.session",
        status: "open",
        url: `https://checkout.stripe.com/c/pay/${id}`,
      });
    }
    if (method === "GET" && path === "/v1/checkout/sessions") {
      const matching = this.sessions.filter(
        (session) =>
          session.customer === (form.customer ?? "") &&
          (form.status === undefined || session.status === form.status),
      );
      const start = form.starting_after
        ? matching.findIndex((session) => session.id === form.starting_after) + 1
        : 0;
      const limit = Math.min(Number(form.limit ?? 10), this.pageSize);
      const data = matching.slice(start, start + limit).map((session) => ({
        id: session.id,
        object: "checkout.session",
        status: session.status,
      }));
      return Response.json({ object: "list", has_more: start + limit < matching.length, data });
    }
    const expire = /^\/v1\/checkout\/sessions\/([^/]+)\/expire$/.exec(path);
    if (method === "POST" && expire) {
      const found = this.sessions.find((session) => session.id === decodeURIComponent(expire[1]!));
      if (!found) return stripeError(404, "No such checkout session");
      if (found.status !== "open") {
        return stripeError(
          400,
          `This Checkout Session has a status of \`${found.status}\` and cannot be expired.`,
        );
      }
      found.status = "expired";
      return Response.json({ id: found.id, object: "checkout.session", status: "expired" });
    }
    if (method === "POST" && path === "/v1/billing_portal/sessions")
      return Response.json({
        id: "bps_fake",
        object: "billing_portal.session",
        url: `https://billing.stripe.com/p/session/${form.customer}`,
      });
    if (method === "GET" && path === "/v1/subscriptions") {
      const matching = this.forCustomer(form.customer ?? "").filter(
        (s) => form.status === "all" || s.status !== "canceled",
      );
      const start = form.starting_after
        ? matching.findIndex((s) => s.id === form.starting_after) + 1
        : 0;
      const limit = Math.min(Number(form.limit ?? 10), this.pageSize);
      const data = matching.slice(start, start + limit);
      return Response.json({ object: "list", has_more: start + limit < matching.length, data });
    }
    const item = /^\/v1\/subscription_items\/([^/]+)$/.exec(path);
    if (method === "POST" && item) {
      const found = this.subscriptions
        .flatMap((s) => s.items.data)
        .find((i) => i.id === decodeURIComponent(item[1]!));
      if (!found) return stripeError(404, "No such subscription item");
      found.quantity = Number(form.quantity);
      return Response.json(found);
    }
    const subscription = /^\/v1\/subscriptions\/([^/]+)$/.exec(path);
    if (method === "DELETE" && subscription) {
      const found = this.subscriptions.find((s) => s.id === decodeURIComponent(subscription[1]!));
      if (!found) return stripeError(404, "No such subscription");
      found.status = "canceled";
      found.ended_at = Math.floor(this.now() / 1000);
      return Response.json(found);
    }
    return stripeError(404, `Unrecognized request URL (${method}: ${path})`);
  }

  private forCustomer(customerId: string) {
    return this.subscriptions
      .filter((s) => s.customer === customerId)
      .sort((a, b) => b.created - a.created);
  }
}

export interface StripeCheckoutSession {
  id: string;
  customer: string;
  status: "open" | "expired" | "complete";
  form: Record<string, string>;
}

export interface StripeSubscriptionRecord {
  id: string;
  object: "subscription";
  customer: string;
  status: string;
  created: number;
  trial_end: number | null;
  cancel_at_period_end: boolean;
  cancel_at: number | null;
  ended_at: number | null;
  items: {
    object: "list";
    data: Array<{
      id: string;
      object: "subscription_item";
      price: { id: string; object: "price" };
      quantity: number;
      current_period_end: number;
    }>;
  };
}

function stripeError(status: number, message: string) {
  return Response.json({ error: { type: "invalid_request_error", message } }, { status });
}
