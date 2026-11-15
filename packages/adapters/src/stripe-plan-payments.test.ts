import { describe, expect, it, vi } from "vitest";
import { StripeBillingProvider } from "./stripe-billing.js";

function provider(routes: Record<string, unknown>) {
  return new StripeBillingProvider({
    secretKey: "sk_test_fixture",
    webhookSecret: "whsec_fixture",
    fetch: vi.fn(async (input) => {
      const url = new URL(String(input));
      const key = `${url.pathname}${url.searchParams.get("invoice") ? `?${url.searchParams.get("invoice")}` : ""}`;
      return Response.json({ data: routes[key] ?? [], has_more: false });
    }),
  });
}

const plan = { subscription_details: { metadata: { rakazo_plan: "byok" } } };

describe("Stripe own-key plan payments", () => {
  it("lists paid own-key plan invoices before tax, leaving out credits and unpaid ones", async () => {
    const payments = await provider({
      "/v1/invoices": [
        {
          id: "in_plan",
          currency: "usd",
          amount_paid: 1650,
          total_taxes: [{ amount: 150 }],
          parent: plan,
        },
        { id: "in_trial", currency: "usd", amount_paid: 0, parent: plan },
        {
          id: "in_monthly_credits",
          currency: "usd",
          amount_paid: 2000,
          parent: { subscription_details: { metadata: { rakazo_credit_cents: "2000" } } },
        },
        { id: "in_credit_top_up", currency: "usd", amount_paid: 2000, parent: null },
      ],
    }).listPlanPayments("cus_fixture");
    expect(payments).toEqual([
      { invoiceId: "in_plan", amountCents: 1500, currency: "usd", reversed: false },
    ]);
  });

  it("marks an invoice reversed when its payment was refunded or disputed", async () => {
    const payments = await provider({
      "/v1/invoices": [
        { id: "in_refunded", currency: "usd", amount_paid: 1500, parent: plan },
        { id: "in_disputed", currency: "usd", amount_paid: 1500, parent: plan },
        { id: "in_kept", currency: "usd", amount_paid: 1500, parent: plan },
      ],
      "/v1/charges": [
        { id: "ch_1", payment_intent: "pi_refunded", disputed: false, refunded: true },
        { id: "ch_2", payment_intent: "pi_disputed", disputed: true, refunded: false },
        { id: "ch_3", payment_intent: "pi_kept", disputed: false, refunded: false },
      ],
      "/v1/invoice_payments?in_refunded": [
        { id: "ip_1", payment: { payment_intent: "pi_refunded" } },
      ],
      "/v1/invoice_payments?in_disputed": [
        { id: "ip_2", payment: { payment_intent: "pi_disputed" } },
      ],
      "/v1/invoice_payments?in_kept": [{ id: "ip_3", payment: { payment_intent: "pi_kept" } }],
    }).listPlanPayments("cus_fixture");
    expect(payments.map(({ invoiceId, reversed }) => [invoiceId, reversed])).toEqual([
      ["in_refunded", true],
      ["in_disputed", true],
      ["in_kept", false],
    ]);
  });
});
