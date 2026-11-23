import type { BillingInvoiceRefund } from "@rakazo/adapter-kit";
import { ClientError } from "@rakazo/core";
import { z } from "zod";

const invoiceSchema = z.object({
  id: z.string(),
  number: z.string().nullable(),
  customer: z.string(),
  currency: z.string(),
  amount_paid: z.number().int().nonnegative(),
});
const paymentSchema = z.object({
  invoice: z.string(),
  currency: z.string(),
  amount_paid: z.number().int().nullable(),
  payment: z.object({ payment_intent: z.string().optional() }),
});
const chargeSchema = z.object({
  id: z.string(),
  customer: z.string(),
  amount: z.number().int(),
  amount_refunded: z.number().int().nonnegative(),
  currency: z.string(),
  paid: z.boolean(),
  captured: z.boolean(),
  disputed: z.boolean(),
  payment_method_details: z.object({ type: z.string() }).nullable(),
});
const refundSchema = z.object({
  id: z.string(),
  amount: z.number().int(),
  status: z.string().nullable(),
});

type StripeInvoiceApi = {
  request(method: "GET" | "POST", path: string, params?: Record<string, unknown>): Promise<unknown>;
  listPages<T>(path: string, schema: z.ZodType<T>): Promise<T[]>;
};

export async function stripeInvoiceRefund(
  api: StripeInvoiceApi,
  customerId: string,
  invoiceNumber: string,
  confirm: boolean,
): Promise<BillingInvoiceRefund | null> {
  const invoices = await api.listPages(
    `/v1/invoices?customer=${encodeURIComponent(customerId)}&status=paid`,
    invoiceSchema,
  );
  const matches = invoices.filter((invoice) => invoice.number === invoiceNumber);
  if (!matches.length) return null;
  const [invoice] = matches;
  if (matches.length !== 1 || !invoice || invoice.customer !== customerId)
    throw new ClientError("CONFLICT", "The invoice does not identify a single billing payment");

  const payments = await api.listPages(
    `/v1/invoice_payments?invoice=${encodeURIComponent(invoice.id)}&status=paid`,
    paymentSchema,
  );
  const [payment] = payments;
  if (
    payments.length !== 1 ||
    !payment?.payment.payment_intent ||
    payment.invoice !== invoice.id ||
    payment.currency !== invoice.currency ||
    payment.amount_paid !== invoice.amount_paid ||
    invoice.amount_paid <= 0
  )
    throw new ClientError("CONFLICT", "The invoice must have one payment for its full amount");

  const intent = z
    .object({ latest_charge: chargeSchema.nullable() })
    .parse(
      await api.request(
        "GET",
        `/v1/payment_intents/${encodeURIComponent(payment.payment.payment_intent)}?expand%5B%5D=latest_charge`,
      ),
    );
  const charge = intent.latest_charge;
  if (
    !charge?.paid ||
    !charge.captured ||
    charge.disputed ||
    charge.customer !== customerId ||
    charge.amount !== invoice.amount_paid ||
    charge.currency !== invoice.currency ||
    charge.payment_method_details?.type !== "card"
  )
    throw new ClientError("CONFLICT", "The invoice must match a settled, undisputed card charge");

  const result = {
    invoiceId: invoice.id,
    amountMinor: invoice.amount_paid,
    currency: invoice.currency,
  };
  if (charge.amount_refunded > 0) {
    const refunds = await api.listPages(
      `/v1/refunds?charge=${encodeURIComponent(charge.id)}`,
      refundSchema,
    );
    const existing = refunds.find(
      (refund) =>
        refund.amount === charge.amount &&
        (refund.status === "pending" || refund.status === "succeeded"),
    );
    if (existing) return { ...result, ...refundStatus(existing) };
    throw new ClientError("CONFLICT", "This charge has a previous refund. Review it in billing.");
  }
  if (!confirm) return { ...result, state: "refundable" };
  // The transport reuses a key for retries within this request. A later confirmation checks
  // refund state again and uses a fresh key, so it can recover from a cached provider error.
  // Stripe caps refunds at the original charge, even if a previous response was lost.
  const refund = refundSchema.parse(
    await api.request("POST", "/v1/refunds", {
      charge: charge.id,
      amount: charge.amount,
      reason: "requested_by_customer",
    }),
  );
  if (refund.amount !== charge.amount)
    throw new ClientError("CONFLICT", "The refund amount needs review in billing");
  return { ...result, ...refundStatus(refund) };
}

function refundStatus(refund: z.infer<typeof refundSchema>) {
  if (refund.status !== "succeeded" && refund.status !== "pending")
    throw new ClientError("CONFLICT", "The refund needs review in billing");
  return { state: refund.status, refundId: refund.id };
}
