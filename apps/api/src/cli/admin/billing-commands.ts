import type { BillingProvider } from "@rakazo/adapter-kit";
import { createDubPartnerProgram, PostgresRealtimeFanout } from "@rakazo/adapters";
import { ownedBillingAccounts, recordAuditEvent, unexpiredCreditAccount } from "@rakazo/db";
import { bestEffort } from "@rakazo/logging";
import { createBillingService } from "../../billing/billing.js";
import { withCheckoutLease } from "../../billing/checkout-lease.js";
import { adminEmail, findAdminAccount } from "./account-target.js";
import type { AdminCommand, AdminContext } from "./admin-command.js";
import { AdminCommandError } from "./admin-command.js";
import { adminBillingProvider } from "./billing-provider.js";

const BILLING_REFERENCE = /^[A-Za-z0-9_-]{1,128}$/;

export const billingCancelCommand: AdminCommand = {
  path: ["billing", "cancel"],
  usage: "<email> [<organization-id>] [--confirm]",
  flags: ["confirm"],
  parse: ([address, organizationId, ...extra], flags) => {
    const email = adminEmail(address);
    if (!email || extra.length || (organizationId && !BILLING_REFERENCE.test(organizationId)))
      return null;
    return (context) => cancelBilling(context, email, organizationId, flags.confirm === true);
  },
};

export const billingRefundCommand: AdminCommand = {
  path: ["billing", "refund"],
  usage: "<email> [<invoice-number-or-id>] [--full] [--confirm]",
  flags: ["confirm", "full"],
  parse: ([address, invoice, ...extra], flags) => {
    const email = adminEmail(address);
    const confirm = flags.confirm === true;
    if (!email || extra.length || (invoice && !BILLING_REFERENCE.test(invoice))) return null;
    // Refunding money names the invoice the preview showed, never whichever is newest by then.
    if (confirm && !invoice) return null;
    return (context) => refundBilling(context, email, invoice, confirm, flags.full === true);
  },
};

async function billingAccounts({ prisma, env }: AdminContext, email: string) {
  const provider = adminBillingProvider(env);
  if (!provider) throw new AdminCommandError("Billing is not configured");
  const user = await findAdminAccount(prisma, email);
  const accounts = await ownedBillingAccounts(prisma, user.id);
  if (!accounts.length) throw new AdminCommandError("This account owns no billing organizations");
  return { provider, accounts, userId: user.id };
}

async function cancelBilling(
  context: AdminContext,
  email: string,
  organizationId: string | undefined,
  confirm: boolean,
) {
  const { provider, accounts } = await billingAccounts(context, email);
  const [only] = accounts;
  const account = organizationId
    ? accounts.find((item) => item.organizationId === organizationId)
    : accounts.length === 1
      ? only
      : undefined;
  if (!account) {
    if (organizationId)
      throw new AdminCommandError("This account does not own that billing organization");
    throw new AdminCommandError(
      `Choose an organization ID: ${accounts.map((item) => item.organizationId).join(", ")}`,
    );
  }

  if (!confirm) {
    const plan = await provider.getCustomerSubscription(account.customerId);
    return {
      text: `Organization ${account.organizationId}. Subscription status: ${plan?.status ?? "none"}. Add --confirm to end subscriptions and expire open checkouts immediately.`,
      json: {
        organizationId: account.organizationId,
        subscriptionStatus: plan?.status ?? null,
        cancelAtPeriodEnd: plan?.cancelAtPeriodEnd ?? false,
        confirmed: false,
      },
    };
  }
  await recordAuditEvent({
    action: "billing.subscriptions.cancel_requested",
    actor: { type: "system", label: "operator" },
    organizationId: account.organizationId,
  });
  await withAdminBilling(context, provider, (billing) =>
    billing.cancelOrganizationSubscriptions(account.organizationId, account.customerId),
  );
  await recordAuditEvent({
    action: "billing.subscriptions.canceled",
    actor: { type: "system", label: "operator" },
    organizationId: account.organizationId,
  });
  return {
    text: "Subscriptions ended and open checkouts expired.",
    json: { organizationId: account.organizationId, confirmed: true },
  };
}

async function refundBilling(
  context: AdminContext,
  email: string,
  invoice: string | undefined,
  confirm: boolean,
  full: boolean,
) {
  const { provider, accounts, userId } = await billingAccounts(context, email);
  const invoiceRefund = provider.refundInvoice?.bind(provider);
  if (!invoiceRefund)
    throw new AdminCommandError("The billing provider does not support invoice refunds");
  const matches = [];
  for (const account of accounts) {
    const refund = await invoiceRefund(account.customerId, invoice, false);
    if (refund) matches.push({ account, refund });
  }
  const [match] = matches;
  if (!invoice && matches.length > 1)
    throw new AdminCommandError(
      `Choose an invoice: ${matches.map(({ refund }) => refund.invoiceNumber ?? refund.invoiceId).join(", ")}`,
    );
  if (matches.length !== 1 || !match)
    throw new AdminCommandError(
      invoice
        ? "No single paid invoice matches that number or id for this account"
        : "This account has no paid invoices",
    );

  const { customerId, organizationId } = match.account;
  let { refund } = match;
  const plan = async () => {
    const credits = await invoiceCredits(context, organizationId, match.refund);
    return { credits, ...refundPlan(credits, match.refund.amountMinor, full) };
  };
  let planned = refund.state === "refundable" ? await plan() : null;
  if (confirm) {
    let attempted = false;
    try {
      refund = await withCheckoutLease(context.prisma, organizationId, async () => {
        const owned = await ownedBillingAccounts(context.prisma, userId);
        if (
          !owned.some(
            (item) => item.organizationId === organizationId && item.customerId === customerId,
          )
        )
          throw new AdminCommandError("The billing account changed. Preview the refund again.");
        // Read again under the lease, so credits used since the preview are kept too. A refund
        // the preview already found is reported as it is, never planned again.
        planned = match.refund.state === "refundable" ? await plan() : null;
        await recordAuditEvent({
          action: "billing.invoice.refund_requested",
          actor: { type: "system", label: "operator" },
          organizationId,
          target: { type: "invoice", id: match.refund.invoiceId },
          ...(planned
            ? { metadata: { refundMinor: planned.refundMinor, keptMinor: planned.keptMinor } }
            : {}),
        });
        attempted = true;
        // With --full, an earlier partial refund is a conflict, not the refund asked for.
        const result = await invoiceRefund(
          customerId,
          invoice,
          true,
          planned?.refundMinor ?? (full ? match.refund.amountMinor : undefined),
        );
        if (!result || result.state === "refundable")
          throw new AdminCommandError(
            "The refund could not be confirmed. Preview the refund again.",
          );
        await recordAuditEvent({
          action: "billing.invoice.refund_result",
          actor: { type: "system", label: "operator" },
          organizationId,
          target: { type: "invoice", id: result.invoiceId },
          metadata: {
            refundId: result.refundId,
            status: result.state,
            amountMinor: result.refundedMinor,
            currency: result.currency,
          },
        });
        return result;
      });
    } finally {
      // An error after sending the request may still leave a refund at the provider.
      if (attempted)
        await bestEffort(
          "reconcile operator invoice refund",
          withAdminBilling(context, provider, async (billing) => {
            await Promise.all([
              bestEffort("sync operator invoice refund", billing.sync(customerId)),
              bestEffort("sync refunded partner sale", billing.reportPartnerSales(customerId)),
            ]);
          }),
        );
    }
  }
  const money = (minor: number) =>
    refund.currency === "usd"
      ? `$${(minor / 100).toFixed(2)}`
      : `${minor} minor units of ${refund.currency.toUpperCase()}`;
  // Only context for the operator: a refund already sent must still report its outcome.
  const [after, subscription] = await Promise.all([
    refund.state === "refundable"
      ? planned?.credits
      : bestEffort(
          "read refund credit summary",
          invoiceCredits(context, organizationId, match.refund),
        ),
    bestEffort("read refund subscription", provider.getCustomerSubscription(customerId)),
  ]);
  const renews =
    subscription === undefined
      ? null
      : !!subscription && subscription.status !== "canceled" && !subscription.cancelAtPeriodEnd;
  const reference = refund.invoiceNumber ?? refund.invoiceId;
  const outcome =
    refund.state === "refundable" && planned
      ? [
          planned.keptMinor
            ? `Refund ${money(planned.refundMinor)} and keep ${money(planned.keptMinor)} for the credits used.`
            : `Refund the full ${money(planned.refundMinor)}.`,
          ...(planned.balanceAfter !== null
            ? [`The balance after the refund is ${usd(planned.balanceAfter)}.`]
            : []),
          `Add ${invoice ? "" : `${reference} `}${full ? "--full " : ""}--confirm to refund it${planned.keptMinor ? ", or --full to refund the whole charge" : ""}.`,
        ]
      : [
          `Refund of ${money(refund.refundedMinor ?? refund.amountMinor)} ${refund.state}.`,
          ...(after ? [`Balance ${usd(after.balanceMicros)}.`] : []),
        ];
  return {
    text: [
      `Invoice ${reference} (${refund.invoiceId}) for organization ${organizationId}, ${money(refund.amountMinor)}, dated ${refund.createdAt.slice(0, 10)}.`,
      ...(refund.state === "refundable" && after ? creditLines(after) : []),
      ...outcome,
      ...(renews ? ["The subscription still renews. Stop it with billing cancel."] : []),
      ...(renews === null
        ? ["Could not read the subscription. Check whether it still renews."]
        : []),
    ].join("\n"),
    json: {
      organizationId,
      ...refund,
      creditPurchaseId: match.refund.creditPurchaseId,
      credits: after
        ? {
            fromInvoice: dollars(after.fromInvoiceMicros),
            used: dollars(after.usedMicros),
            balance: dollars(after.balanceMicros),
            byModel: after.byModel.map(({ model, micros }) => ({ model, usd: dollars(micros) })),
          }
        : null,
      ...(planned?.balanceAfter != null
        ? { balanceAfterRefund: dollars(planned.balanceAfter) }
        : {}),
      ...(planned ? { refundMinor: planned.refundMinor, keptMinor: planned.keptMinor } : {}),
      subscriptionRenews: renews,
    },
  };
}

/** Model credits the invoice bought and used, what the organization spent since, and its balance. */
async function invoiceCredits(
  { prisma }: AdminContext,
  organizationId: string,
  refund: { creditPurchaseId: string; createdAt: string },
) {
  if (!(await prisma.modelCreditAccount.findUnique({ where: { organizationId } }))) return null;
  // Credits that lapsed but are not expired yet would otherwise inflate the balance.
  const [account, entry] = await Promise.all([
    unexpiredCreditAccount(prisma, organizationId),
    prisma.modelCreditEntry.findUnique({
      where: { source: `purchase:${refund.creditPurchaseId}` },
    }),
  ]);
  // An invoice that bought no credits, such as an own-key plan, still shows the balance.
  const purchase = entry?.organizationId === organizationId ? entry : null;
  const [lot, spent] = await Promise.all([
    purchase ? prisma.modelCreditLot.findUnique({ where: { id: purchase.id } }) : null,
    // The purchase is recorded once the payment settles, which can be well after the invoice date.
    prisma.modelCreditEntry.groupBy({
      by: ["model"],
      where: {
        organizationId,
        // Holds for calls still running count too: the balance already excludes them.
        callId: { not: null },
        createdAt: { gte: purchase?.createdAt ?? new Date(refund.createdAt) },
      },
      _sum: { amountMicros: true },
    }),
  ]);
  return {
    // Purchases from before credit lots existed get theirs on the account's next credit use.
    usageKnown: !purchase || !!lot || purchase.amountMicros === 0n,
    // What the invoice still funds: a synced refund lowers it.
    fromInvoiceMicros: purchase?.amountMicros ?? 0n,
    // Includes holds for calls still running.
    usedMicros: lot?.usedMicros ?? 0n,
    // Credits past their expiry already left the balance, though the reconciler may not have
    // marked them expired yet.
    expiredMicros:
      lot?.expiresAt && lot.expiresAt <= new Date()
        ? lot.amountMicros - lot.usedMicros
        : (lot?.expiredMicros ?? 0n),
    balanceMicros: account.balanceMicros,
    byModel: spent
      .map(({ model, _sum }) => ({ model: model ?? "unknown", micros: -(_sum.amountMicros ?? 0n) }))
      .filter(({ micros }) => micros > 0n)
      .toSorted((a, b) => Number(b.micros - a.micros)),
  };
}

type InvoiceCredits = NonNullable<Awaited<ReturnType<typeof invoiceCredits>>>;

/**
 * How much of the charge to refund. Unless `full`, it keeps the share of the payment that paid
 * for credits already used: billing sync then cuts the purchase down to those credits, so the
 * balance lands near zero instead of below it.
 */
function refundPlan(credits: InvoiceCredits | null, paidMinor: number, full: boolean) {
  if (!full && credits && !credits.usageKnown)
    throw new AdminCommandError(
      "This purchase's credit use is not recorded yet. Add --full to refund the whole charge.",
    );
  const bought = credits?.fromInvoiceMicros ?? 0n;
  const used = credits && credits.usedMicros < bought ? credits.usedMicros : bought;
  const paid = BigInt(paidMinor);
  // Sync grants whole cents in proportion to what stays paid, so keep the least payment whose
  // grant covers the cents used.
  const boughtCents = bought / 10_000n;
  const usedCents = (used + 9_999n) / 10_000n;
  const kept =
    full || boughtCents === 0n ? 0n : (usedCents * paid + boughtCents - 1n) / boughtCents;
  if (kept >= paid)
    throw new AdminCommandError(
      "This invoice's credits are all used, so nothing is left to refund. Add --full to refund the whole charge.",
    );
  // Sync shrinks the purchase to what the kept amount buys, cutting expired credits first; only
  // the cut from credits still available comes off the balance.
  const remaining = ((boughtCents * kept) / paid) * 10_000n;
  const available = (amount: bigint, expired: bigint) => {
    const left = amount - used - expired;
    return left > 0n ? left : 0n;
  };
  const expired = credits?.expiredMicros ?? 0n;
  const expiredAfter = expired - (bought - remaining) > 0n ? expired - (bought - remaining) : 0n;
  const balanceAfter = credits
    ? credits.balanceMicros - available(bought, expired) + available(remaining, expiredAfter)
    : null;
  return { refundMinor: Number(paid - kept), keptMinor: Number(kept), balanceAfter };
}

function dollars(micros: bigint) {
  return Number(micros) / 1e6;
}

function usd(micros: bigint) {
  const cents = Number(micros < 0n ? -micros : micros) / 1e4;
  return `${micros < 0n ? "-" : ""}$${(Math.round(cents) / 100).toFixed(2)}`;
}

function creditLines(credits: InvoiceCredits) {
  return [
    `Credits: ${usd(credits.fromInvoiceMicros)} from this invoice, ${usd(credits.usedMicros)} of them used, balance ${usd(credits.balanceMicros)}.`,
    ...(credits.byModel.length ? ["Spent since it was paid:"] : []),
    ...credits.byModel.map(({ model, micros }) => `  ${model} ${usd(micros)}`),
  ];
}

async function withAdminBilling<T>(
  { prisma, pool, env }: AdminContext,
  provider: BillingProvider,
  run: (service: ReturnType<typeof createBillingService>) => Promise<T>,
) {
  const realtime = new PostgresRealtimeFanout({
    connectionString: env.realtimeDatabaseUrl,
    publisher: pool,
  });
  try {
    return await run(
      createBillingService({
        prisma,
        provider,
        realtime,
        webOrigin: env.webOrigin,
        partnerProgram: env.dubApiKey ? createDubPartnerProgram(env.dubApiKey) : undefined,
      }),
    );
  } finally {
    await realtime.close();
  }
}
