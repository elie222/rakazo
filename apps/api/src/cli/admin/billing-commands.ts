import type { BillingProvider } from "@rakazo/adapter-kit";
import { PostgresRealtimeFanout } from "@rakazo/adapters";
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
  usage: "<email> <invoice-number> [--confirm]",
  flags: ["confirm"],
  parse: ([address, invoice, ...extra], flags) => {
    const email = adminEmail(address);
    if (!email || !invoice || !BILLING_REFERENCE.test(invoice) || extra.length) return null;
    return (context) => refundBilling(context, email, invoice, flags.confirm === true);
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
  invoiceNumber: string,
  confirm: boolean,
) {
  const { provider, accounts, userId } = await billingAccounts(context, email);
  const invoiceRefund = provider.refundInvoice?.bind(provider);
  if (!invoiceRefund)
    throw new AdminCommandError("The billing provider does not support invoice refunds");
  const matches = [];
  for (const account of accounts) {
    const refund = await invoiceRefund(account.customerId, invoiceNumber, false);
    if (refund) matches.push({ account, refund });
  }
  const [match] = matches;
  if (matches.length !== 1 || !match)
    throw new AdminCommandError("No single paid invoice matches that number for this account");

  const { customerId, organizationId } = match.account;
  let { refund } = match;
  if (confirm) {
    refund = await withCheckoutLease(context.prisma, organizationId, async () => {
      const owned = await ownedBillingAccounts(context.prisma, userId);
      if (
        !owned.some(
          (item) => item.organizationId === organizationId && item.customerId === customerId,
        )
      )
        throw new AdminCommandError("The billing account changed. Preview the refund again.");
      const result = await invoiceRefund(customerId, invoiceNumber, true);
      if (!result || result.state === "refundable")
        throw new AdminCommandError("The refund could not be confirmed. Preview the refund again.");
      return result;
    });
    await recordAuditEvent({
      action: "billing.invoice.refund_requested",
      actor: { type: "system", label: "operator" },
      organizationId,
      target: { type: "invoice", id: refund.invoiceId },
      metadata: { refundId: refund.refundId, status: refund.state },
    });
    await bestEffort(
      "reconcile operator invoice refund",
      withAdminBilling(context, provider, (billing) => billing.sync(customerId)),
    );
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
  return {
    text: `Invoice ${invoiceNumber} for organization ${organizationId}, ${amount}. ${status}`,
    json: { organizationId, invoiceNumber, ...refund },
  };
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
      createBillingService({ prisma, provider, realtime, webOrigin: env.webOrigin }),
    );
  } finally {
    await realtime.close();
  }
}
