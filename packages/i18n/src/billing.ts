import { i18n } from "@lingui/core";
import type { BillingStatus } from "@rakazo/contracts";
import { billingDate, formatMinorAmount } from "@rakazo/core";

/**
 * Prices and billing dates both apps show, kept here so they read the same on each. Static
 * descriptors keep the copy in Lingui extraction, under the macro-generated catalog IDs so the
 * existing translations still apply.
 */

type Price = NonNullable<BillingStatus["price"]>;

/** "$12" from an amount in minor units, without cents when it is whole. */
export function formatBillingAmount(minorUnits: number, currency: string, locale: string): string {
  return formatMinorAmount(minorUnits, currency, locale, { wholeWithoutCents: true });
}

/** "$12 / month" from a provider price in minor units. */
export function formatBillingPrice(price: Price, locale: string): string {
  const amount = formatBillingAmount(price.amount, price.currency, locale);
  const period = billingPeriod(price.interval, price.intervalCount);
  return i18n._({
    id: "0EBqaS",
    message: "{amount} / {period}",
    values: { amount, period },
  });
}

/** "$12 / month" from a monthly plan price in US cents. */
export function formatMonthlyPrice(cents: number, locale: string): string {
  return formatBillingPrice(
    { amount: cents, currency: "usd", interval: "month", intervalCount: 1 },
    locale,
  );
}

function billingPeriod(interval: Price["interval"], count: number): string {
  if (count === 1) {
    if (interval === "day") return i18n._({ id: "/ITcnz", message: "day" });
    if (interval === "week") return i18n._({ id: "64X6l4", message: "week" });
    if (interval === "month") return i18n._({ id: "kY2ll9", message: "month" });
    return i18n._({ id: "7qI8sJ", message: "year" });
  }
  if (interval === "day")
    return i18n._({ id: "6UxNGy", message: "{count} days", values: { count } });
  if (interval === "week")
    return i18n._({ id: "YuGiH0", message: "{count} weeks", values: { count } });
  if (interval === "month")
    return i18n._({ id: "/RQB8K", message: "{count} months", values: { count } });
  return i18n._({ id: "lmeS7J", message: "{count} years", values: { count } });
}

/** "Dec 2, 2026" from an ISO date. */
export function formatBillingDate(iso: string, locale: string): string {
  return new Date(iso).toLocaleDateString(locale, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/** "Renews Dec 2, 2026", or when the trial or subscription ends. */
export function billingDateLabel(status: BillingStatus, locale: string): string | null {
  const date = billingDate(status);
  if (!date) return null;
  const day = formatBillingDate(date.at, locale);
  if (date.kind === "trial")
    return i18n._({ id: "Nlt+k3", message: "Trial ends {day}", values: { day } });
  return date.kind === "ends"
    ? i18n._({ id: "NHSZCc", message: "Ends {day}", values: { day } })
    : i18n._({ id: "0oKxPe", message: "Renews {day}", values: { day } });
}
