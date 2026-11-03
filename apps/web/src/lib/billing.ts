import { t } from "@lingui/core/macro";
import type { BillingStatus } from "@rakazo/contracts";

type Price = NonNullable<BillingStatus["price"]>;

/** "$12 / month" from a provider price in minor units. */
export function formatBillingPrice(price: Price, locale: string): string {
  const amount = formatBillingAmount(price.amount, price.currency, locale);
  const period = billingPeriod(price.interval, price.intervalCount);
  return t`${amount} / ${period}`;
}

/** "$12" from an amount in minor units, without cents when it is whole. */
export function formatBillingAmount(minorUnits: number, code: string, locale: string): string {
  const currency = code.toUpperCase();
  const digits = new Intl.NumberFormat(locale, { style: "currency", currency }).resolvedOptions()
    .maximumFractionDigits;
  const value = minorUnits / 10 ** (digits ?? 2);
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    minimumFractionDigits: Number.isInteger(value) ? 0 : digits,
  }).format(value);
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
