import type { BillingProvider } from "@rakazo/adapter-kit";
import { createDubPartnerProgram, PostgresRealtimeFanout } from "@rakazo/adapters";
import { ownedBillingAccounts, recordAuditEvent } from "@rakazo/db";
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
  usage: "<email> [<invoice-number-or-id>] [--confirm]",
  flags: ["confirm"],
  parse: ([address, invoice, ...extra], flags) => {
    const email = adminEmail(address);
    const confirm = flags.confirm === true;
    if (!email || extra.length || (invoice && !BILLING_REFERENCE.test(invoice))) return null;
    // Refunding money names the invoice the preview showed, never whichever is newest by then.
    if (confirm && !invoice) return null;
    return (context) => refundBilling(context, email, invoice, confirm);
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
        await recordAuditEvent({
          action: "billing.invoice.refund_requested",
          actor: { type: "system", label: "operator" },
          organizationId,
          target: { type: "invoice", id: match.refund.invoiceId },
        });
        attempted = true;
        const result = await invoiceRefund(customerId, invoice, true);
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
            amountMinor: result.amountMinor,
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
  const status = {
    refundable: "Add --confirm to refund the full charge.",
    pending: "Refund pending.",
    succeeded: "Refund succeeded.",
  }[refund.state];
  const amount =
    refund.currency === "usd"
      ? `$${(refund.amountMinor / 100).toFixed(2)} USD`
      : `${refund.amountMinor} minor units of ${refund.currency.toUpperCase()}`;
  // Only context for the operator: a refund already sent must still report its outcome.
  const [credits, plan] = await Promise.all([
    bestEffort("read refund credit summary", invoiceCredits(context, organizationId, match.refund)),
    bestEffort("read refund subscription", provider.getCustomerSubscription(customerId)),
  ]);
  const renews =
    plan === undefined ? null : !!plan && plan.status !== "canceled" && !plan.cancelAtPeriodEnd;
  const reference = refund.invoiceNumber ?? refund.invoiceId;
  return {
    text: [
      `Invoice ${reference} (${refund.invoiceId}) for organization ${organizationId}, ${amount}, dated ${refund.createdAt.slice(0, 10)}.`,
      ...(credits ? creditLines(credits, refund.state === "refundable") : []),
      refund.state === "refundable" && !invoice
        ? `Add ${reference} --confirm to refund the full charge.`
        : status,
      ...(renews ? ["The subscription still renews. Stop it with billing cancel."] : []),
      ...(renews === null
        ? ["Could not read the subscription. Check whether it still renews."]
        : []),
    ].join("\n"),
    json: { organizationId, ...refund, credits, subscriptionRenews: renews },
  };
}

/** Model credits the invoice bought, what the organization spent since, and its balance. */
async function invoiceCredits(
  { prisma }: AdminContext,
  organizationId: string,
  refund: { creditPurchaseId: string; createdAt: string },
) {
  const [account, entry] = await Promise.all([
    prisma.modelCreditAccount.findUnique({ where: { organizationId } }),
    prisma.modelCreditEntry.findUnique({
      where: { source: `purchase:${refund.creditPurchaseId}` },
    }),
  ]);
  if (!account) return null;
  // An invoice that bought no credits, such as an own-key plan, still shows the balance.
  const purchase = entry?.organizationId === organizationId ? entry : null;
  // The purchase is recorded once the payment settles, which can be well after the invoice date.
  const spent = await prisma.modelCreditEntry.groupBy({
    by: ["model"],
    where: {
      organizationId,
      // Holds for calls still running count too: the balance already excludes them.
      callId: { not: null },
      createdAt: { gte: purchase?.createdAt ?? new Date(refund.createdAt) },
    },
    _sum: { amountMicros: true },
  });
  // What the invoice still funds: a synced refund lowers it to zero.
  const fromInvoice = purchase?.amountMicros ?? 0n;
  const byModel = spent
    .map(({ model, _sum }) => ({
      model: model ?? "unknown",
      usd: Number(-(_sum.amountMicros ?? 0n)) / 1e6,
    }))
    .filter(({ usd }) => usd > 0)
    .toSorted((a, b) => b.usd - a.usd);
  const usd = (micros: bigint) => Number(micros) / 1e6;
  return {
    fromInvoice: usd(fromInvoice),
    spentSincePaid: usd(-spent.reduce((total, { _sum }) => total + (_sum.amountMicros ?? 0n), 0n)),
    byModel,
    balance: usd(account.balanceMicros),
    balanceAfterRefund: usd(account.balanceMicros - fromInvoice),
  };
}

function creditLines(
  credits: NonNullable<Awaited<ReturnType<typeof invoiceCredits>>>,
  preview: boolean,
) {
  const usd = (value: number) => `${value < 0 ? "-" : ""}$${Math.abs(value).toFixed(2)}`;
  return [
    `Credits: ${usd(credits.fromInvoice)} from this invoice, ${usd(credits.spentSincePaid)} spent since it was paid, balance ${usd(credits.balance)}.`,
    ...credits.byModel.map(({ model, usd: spent }) => `  ${model} ${usd(spent)}`),
    ...(preview && credits.fromInvoice > 0
      ? [
          `The refund takes back this invoice's credits, leaving a balance of ${usd(credits.balanceAfterRefund)}.`,
        ]
      : []),
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
