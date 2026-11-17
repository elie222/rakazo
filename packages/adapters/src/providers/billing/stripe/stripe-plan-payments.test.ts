import { describe, expect, it, vi } from "vitest";
import { StripeBillingProvider } from "./stripe-billing.js";

function provider(routes: Record<string, unknown>) {
  const paths: string[] = [];
  const stripe = new StripeBillingProvider({
    secretKey: "sk_test_fixture",
    webhookSecret: "whsec_fixture",
    fetch: vi.fn(async (input) => {
      const url = new URL(String(input));
      paths.push(`${url.pathname}${url.search}`);
      const scope = url.searchParams.get("invoice") ?? url.searchParams.get("payment_intent");
      return Response.json({
        data: routes[`${url.pathname}${scope ? `?${scope}` : ""}`] ?? [],
        has_more: false,
      });
    }),
  });
  return { stripe, paths };
}

const plan = { subscription_details: { metadata: { rakazo_plan: "byok" } } };
const since = new Date(1_790_000_000_000);

describe("Stripe own-key plan payments", () => {
  it("lists paid own-key plan invoices before tax, leaving out credits and unpaid ones", async () => {
    const { stripe, paths } = provider({
      "/v1/invoices": [
        {
          id: "in_plan",
          currency: "usd",
          amount_paid: 1650,
          total_taxes: [{ amount: 150 }],
          created: 1_799_000_000,
          parent: plan,
        },
        {
          id: "in_trial",
          currency: "usd",
          amount_paid: 0,
          created: 1_799_000_000,
          parent: plan,
        },
        {
          id: "in_monthly_credits",
          currency: "usd",
          amount_paid: 2000,
          created: 1_799_000_000,
          parent: { subscription_details: { metadata: { rakazo_credit_cents: "2000" } } },
        },
        {
          id: "in_credit_top_up",
          currency: "usd",
          amount_paid: 2000,
          created: 1_799_000_000,
          parent: null,
        },
      ],
    });
    expect(await stripe.listPlanPayments("cus_fixture", since)).toEqual([
      {
        invoiceId: "in_plan",
        amountCents: 1500,
        currency: "usd",
        createdAt: new Date(1_799_000_000_000),
        reversed: false,
      },
    ]);
    expect(paths.every((path) => path.includes("created[gte]=1790000000"))).toBe(true);
  });

  it("marks an invoice reversed only when every payment on it was refunded or lost a dispute", async () => {
    const invoice = (id: string) => ({
      id,
      currency: "usd",
      amount_paid: 1500,
      created: 1_799_000_000,
      parent: plan,
    });
    const { stripe } = provider({
      "/v1/invoices": [
        invoice("in_refunded"),
        invoice("in_disputed"),
        invoice("in_kept"),
        invoice("in_partly"),
        invoice("in_dispute_won"),
        invoice("in_dispute_open"),
      ],
      "/v1/charges": [
        { id: "ch_1", payment_intent: "pi_refunded", disputed: false, refunded: true },
        { id: "ch_2", payment_intent: "pi_disputed", disputed: true, refunded: false },
        { id: "ch_3", payment_intent: "pi_kept", disputed: false, refunded: false },
        { id: "ch_4", payment_intent: "pi_partly_refunded", disputed: false, refunded: true },
        { id: "ch_5", payment_intent: "pi_partly_kept", disputed: false, refunded: false },
        { id: "ch_6", payment_intent: "pi_won", disputed: true, refunded: false },
        { id: "ch_7", payment_intent: "pi_open", disputed: true, refunded: false },
      ],
      "/v1/disputes?pi_disputed": [{ id: "dp_1", status: "lost" }],
      "/v1/disputes?pi_won": [{ id: "dp_2", status: "won" }],
      "/v1/disputes?pi_open": [{ id: "dp_3", status: "under_review" }],
      "/v1/invoice_payments?in_dispute_won": [
        { id: "ip_6", payment: { payment_intent: "pi_won" } },
      ],
      "/v1/invoice_payments?in_dispute_open": [
        { id: "ip_7", payment: { payment_intent: "pi_open" } },
      ],
      "/v1/invoice_payments?in_refunded": [
        { id: "ip_1", payment: { payment_intent: "pi_refunded" } },
      ],
      "/v1/invoice_payments?in_disputed": [
        { id: "ip_2", payment: { payment_intent: "pi_disputed" } },
      ],
      "/v1/invoice_payments?in_kept": [{ id: "ip_3", payment: { payment_intent: "pi_kept" } }],
      "/v1/invoice_payments?in_partly": [
        { id: "ip_4", payment: { payment_intent: "pi_partly_refunded" } },
        { id: "ip_5", payment: { payment_intent: "pi_partly_kept" } },
      ],
    });
    const payments = await stripe.listPlanPayments("cus_fixture", since);
    expect(payments.map(({ invoiceId, reversed }) => [invoiceId, reversed])).toEqual([
      ["in_refunded", true],
      ["in_disputed", true],
      ["in_kept", false],
      ["in_partly", false],
      ["in_dispute_won", false],
      ["in_dispute_open", false],
    ]);
  });
});
