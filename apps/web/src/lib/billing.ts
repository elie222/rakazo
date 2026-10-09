import { t } from "@lingui/core/macro";
import type { BillingStatus } from "@rakazo/contracts";

type Price = NonNullable<BillingStatus["price"]>;

/** "$12 / month" from a provider price in minor units. */
export function formatBillingPrice(price: Price, locale: string): string {
  const currency = price.currency.toUpperCase();
  const digits = new Intl.NumberFormat(locale, { style: "currency", currency }).resolvedOptions()
    .maximumFractionDigits;
  const value = price.amount / 10 ** (digits ?? 2);
  const amount = new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    minimumFractionDigits: Number.isInteger(value) ? 0 : digits,
  }).format(value);
  const period = billingPeriod(price.interval, price.intervalCount);
  return t`${amount} / ${period}`;
}

function billingPeriod(interval: Price["interval"], count: number): string {
  if (count === 1) {
    if (interval === "day") return t`day`;
    if (interval === "week") return t`week`;
    if (interval === "month") return t`month`;
    return t`year`;
  }
  if (interval === "day") return t`${count} days`;
  if (interval === "week") return t`${count} weeks`;
  if (interval === "month") return t`${count} months`;
  return t`${count} years`;
}

export function formatBillingDate(iso: string, locale: string): string {
  return new Date(iso).toLocaleDateString(locale, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}
