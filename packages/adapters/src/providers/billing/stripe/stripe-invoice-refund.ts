import type { BillingInvoiceRefund } from "@rakazo/adapter-kit";
import { ClientError } from "@rakazo/core";
import { z } from "zod";

const invoiceSchema = z.object({
  id: z.string(),
  number: z.string().nullable(),
  customer: z.string(),
  currency: z.string(),
  amount_paid: z.number().int().nonnegative(),
  created: z.number().int(),
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
  metadata: z.record(z.string(), z.string()).nullish(),
});
/** Marks the refunds this sends, so a repeat never mistakes someone else's refund for its own. */
const REFUND_MARK = "rakazo_operator_refund";

type StripeInvoiceApi = {
  request(method: "GET" | "POST", path: string, params?: Record<string, unknown>): Promise<unknown>;
  listPages<T>(path: string, schema: z.ZodType<T>): Promise<T[]>;
};

export async function stripeInvoiceRefund(
  api: StripeInvoiceApi,
  customerId: string,
  reference: string | undefined,
  confirm: boolean,
  amountMinor?: number,
): Promise<BillingInvoiceRefund | null> {
  const invoices = await api.listPages(
    `/v1/invoices?customer=${encodeURIComponent(customerId)}&status=paid`,
    invoiceSchema,
  );
  const matches = reference
    ? invoices.filter((invoice) => invoice.number === reference || invoice.id === reference)
    : invoices
        .filter((invoice) => invoice.amount_paid > 0)
        .toSorted((a, b) => b.created - a.created)
        .slice(0, 1);
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

  // One-time credits are bought through a checkout session, which their purchase is listed under.
  // Only the preview's credit summary needs it, so a confirmation never waits on it.
  const [session] = confirm
    ? []
    : await api.listPages(
        `/v1/checkout/sessions?payment_intent=${encodeURIComponent(payment.payment.payment_intent)}`,
        z.object({ id: z.string(), mode: z.string() }),
      );

  const result = {
    invoiceId: invoice.id,
    invoiceNumber: invoice.number,
    createdAt: new Date(invoice.created * 1000).toISOString(),
    creditPurchaseId: session?.mode === "payment" ? session.id : invoice.id,
    amountMinor: invoice.amount_paid,
    currency: invoice.currency,
  };
  if (charge.amount_refunded > 0) {
    const refunds = await api.listPages(
      `/v1/refunds?charge=${encodeURIComponent(charge.id)}`,
      refundSchema,
    );
    const live = refunds.filter(
      (refund) => refund.status === "pending" || refund.status === "succeeded",
    );
    const [existing] = live;
    // Only one marked refund covering everything refunded is this command's, maybe from a lost
    // response; a repeat asking for a different amount must not pass as that one.
    if (
      existing &&
      live.length === 1 &&
      // Full refunds sent before the mark existed carry none.
      (existing.metadata?.[REFUND_MARK] === "1" || existing.amount === charge.amount) &&
      existing.amount === charge.amount_refunded &&
      (amountMinor === undefined || amountMinor === existing.amount)
    )
      return { ...result, ...refundStatus(existing) };
    throw new ClientError("CONFLICT", "This charge has a previous refund. Review it in billing.");
  }
  const amount = amountMinor ?? charge.amount;
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > charge.amount)
    throw new ClientError(
      "BAD_REQUEST",
      "The refund must be more than zero and at most the charge",
    );
  if (!confirm) return { ...result, state: "refundable" };
  // The transport reuses a key for retries within this request. A later confirmation checks
  // refund state again and uses a fresh key, so it can recover from a cached provider error.
  // Stripe caps refunds at the original charge, even if a previous response was lost.
  const refund = refundSchema.parse(
    await api.request("POST", "/v1/refunds", {
      charge: charge.id,
      amount,
      reason: "requested_by_customer",
      metadata: { [REFUND_MARK]: "1" },
    }),
  );
  if (refund.amount !== amount)
    throw new ClientError("CONFLICT", "The refund amount needs review in billing");
  return { ...result, ...refundStatus(refund) };
}

function refundStatus(refund: z.infer<typeof refundSchema>) {
  if (refund.status !== "succeeded" && refund.status !== "pending")
    throw new ClientError("CONFLICT", "The refund needs review in billing");
  return { state: refund.status, refundId: refund.id, refundedMinor: refund.amount };
}
