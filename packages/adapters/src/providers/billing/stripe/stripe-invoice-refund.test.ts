import { describe, expect, it } from "vitest";
import { StripeBillingProvider } from "./stripe-billing.js";

const customer = "cus_fixture";
const invoiceNumber = "EXAMPLE-0001";
const invoice = {
  id: "in_fixture",
  number: invoiceNumber,
  customer,
  currency: "usd",
  amount_paid: 1000,
  created: 1_800_000_000,
};
const payment = {
  id: "inpay_fixture",
  invoice: invoice.id,
  currency: invoice.currency,
  amount_paid: invoice.amount_paid,
  payment: { payment_intent: "pi_fixture" },
};
const charge = {
  id: "ch_fixture",
  customer,
  amount: 1000,
  amount_refunded: 0,
  currency: "usd",
  paid: true,
  captured: true,
  disputed: false,
  payment_method_details: { type: "card" },
};

function fixture(options?: {
  invoices?: (typeof invoice)[];
  sessions?: Array<{ id: string; mode: string }>;
  payments?: (typeof payment)[];
  charge?: Partial<typeof charge>;
  cacheFirstRefundError?: boolean;
}) {
  const writes: Array<{ body: string; key: string | null }> = [];
  const refund = {
    id: "re_fixture",
    amount: 1000,
    status: "pending",
    metadata: { rakazo_operator_refund: "1" },
  };
  const latestCharge = { ...charge, ...options?.charge };
  const list = (data: unknown[]) => Response.json({ data, has_more: false });
  const provider = new StripeBillingProvider({
    secretKey: "sk_test_fixture",
    webhookSecret: "whsec_fixture",
    sleep: async () => {},
    fetch: async (input, init) => {
      const url = new URL(String(input));
      switch (url.pathname) {
        case "/v1/invoices":
          expect(url.searchParams.get("customer")).toBe(customer);
          expect(url.searchParams.get("status")).toBe("paid");
          return list(options?.invoices ?? [invoice]);
        case "/v1/invoice_payments":
          expect(url.searchParams.get("invoice")).toBe(invoice.id);
          return list(options?.payments ?? [payment]);
        case "/v1/checkout/sessions":
          expect(url.searchParams.get("payment_intent")).toBe("pi_fixture");
          return list(options?.sessions ?? []);
        case "/v1/payment_intents/pi_fixture":
          expect(url.searchParams.get("expand[]")).toBe("latest_charge");
          return Response.json({ latest_charge: latestCharge });
        case "/v1/refunds":
          if (init?.method === "GET") return list([refund]);
          writes.push({
            body: String(init?.body),
            key: new Headers(init?.headers).get("Idempotency-Key"),
          });
          if (options?.cacheFirstRefundError && writes.at(-1)?.key === writes[0]?.key)
            return Response.json({ error: { message: "Cached refund error" } }, { status: 500 });
          refund.amount = Number(new URLSearchParams(String(init?.body)).get("amount"));
          latestCharge.amount_refunded = refund.amount;
          return Response.json(refund);
        default:
          throw new Error(`Unexpected billing request ${url.pathname}`);
      }
    },
  });
  return { provider, writes };
}

describe("operator invoice refunds", () => {
  it("previews a charge and reports an existing pending refund without repeating it", async () => {
    const { provider, writes } = fixture();
    await expect(provider.refundInvoice(customer, invoiceNumber, false)).resolves.toEqual({
      invoiceId: invoice.id,
      invoiceNumber,
      createdAt: new Date(invoice.created * 1000).toISOString(),
      creditPurchaseId: invoice.id,
      amountMinor: invoice.amount_paid,
      currency: invoice.currency,
      state: "refundable",
    });
    expect(writes).toEqual([]);
    const refunded = await provider.refundInvoice(customer, invoiceNumber, true);
    expect(refunded).toMatchObject({ state: "pending", refundId: "re_fixture" });
    await expect(provider.refundInvoice(customer, invoiceNumber, true)).resolves.toEqual(refunded);
    expect(writes).toHaveLength(1);
    expect(writes[0]?.key).toEqual(expect.any(String));
    expect(Object.fromEntries(new URLSearchParams(writes[0]?.body))).toEqual({
      charge: "ch_fixture",
      amount: "1000",
      reason: "requested_by_customer",
      "metadata[rakazo_operator_refund]": "1",
    });
  });

  it("finds an invoice by its id, or the newest one that charged when none is named", async () => {
    const older = {
      ...invoice,
      id: "in_older",
      number: "EXAMPLE-0000",
      created: invoice.created - 1,
    };
    const trial = {
      ...invoice,
      id: "in_trial",
      number: "EXAMPLE-0002",
      created: invoice.created + 1,
      amount_paid: 0,
    };
    const { provider } = fixture({ invoices: [older, invoice, trial] });
    await expect(provider.refundInvoice(customer, invoice.id, false)).resolves.toMatchObject({
      invoiceNumber,
    });
    await expect(provider.refundInvoice(customer, undefined, false)).resolves.toMatchObject({
      invoiceId: invoice.id,
    });
  });

  it("names one-time credits by the checkout session that bought them", async () => {
    const { provider } = fixture({ sessions: [{ id: "cs_fixture", mode: "payment" }] });
    await expect(provider.refundInvoice(customer, invoiceNumber, false)).resolves.toMatchObject({
      creditPurchaseId: "cs_fixture",
    });
  });

  it("refunds part of the charge and recognizes that refund on a repeat", async () => {
    const { provider, writes } = fixture();
    await expect(provider.refundInvoice(customer, invoiceNumber, true, 600)).resolves.toMatchObject(
      { state: "pending", refundedMinor: 600 },
    );
    await expect(provider.refundInvoice(customer, invoiceNumber, true, 600)).resolves.toMatchObject(
      { refundedMinor: 600 },
    );
    expect(writes).toHaveLength(1);
    expect(new URLSearchParams(writes[0]?.body).get("amount")).toBe("600");
  });

  it("refuses to pass off another refund as the one asked for", async () => {
    const { provider } = fixture();
    await provider.refundInvoice(customer, invoiceNumber, true, 600);
    await expect(provider.refundInvoice(customer, invoiceNumber, true, 700)).rejects.toMatchObject({
      kind: "CONFLICT",
    });
  });

  it("uses a fresh key on a new confirmation after a cached request error", async () => {
    const { provider, writes } = fixture({ cacheFirstRefundError: true });
    await expect(provider.refundInvoice(customer, invoiceNumber, true)).rejects.toThrow(
      "Cached refund error",
    );
    await expect(provider.refundInvoice(customer, invoiceNumber, true)).resolves.toMatchObject({
      state: "pending",
    });
    expect(writes.map(({ key }) => key)).toEqual([
      writes[0]?.key,
      writes[0]?.key,
      writes[0]?.key,
      expect.any(String),
    ]);
    expect(writes.at(-1)?.key).not.toBe(writes[0]?.key);
  });

  it("refuses mixed payments and disputed or mismatched charges before writing", async () => {
    for (const options of [
      { payments: [payment, { ...payment, id: "inpay_other" }] },
      { charge: { disputed: true } },
      { charge: { customer: "cus_other" } },
      { charge: { amount: 1200 } },
    ]) {
      const { provider, writes } = fixture(options);
      await expect(provider.refundInvoice(customer, invoiceNumber, true)).rejects.toMatchObject({
        kind: "CONFLICT",
      });
      expect(writes).toEqual([]);
    }
  });
});
