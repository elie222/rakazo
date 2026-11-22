import { i18n } from "@lingui/core";
import type { BillingStatus } from "@rakazo/contracts";
import { billingDate, formatMinorAmount } from "@rakazo/core";

/**
 * Prices and billing dates both apps show, kept here so they read the same on each. Static
 * descriptors keep the copy in Lingui extraction.
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
    id: "{amount} / {period}",
    message: "{amount} / {period}",
    values: { amount, period },
  });
}

function billingPeriod(interval: Price["interval"], count: number): string {
  if (count === 1) {
    if (interval === "day") return i18n._({ id: "day", message: "day" });
    if (interval === "week") return i18n._({ id: "week", message: "week" });
    if (interval === "month") return i18n._({ id: "month", message: "month" });
    return i18n._({ id: "year", message: "year" });
  }
  if (interval === "day")
    return i18n._({ id: "{count} days", message: "{count} days", values: { count } });
  if (interval === "week")
    return i18n._({ id: "{count} weeks", message: "{count} weeks", values: { count } });
  if (interval === "month")
    return i18n._({ id: "{count} months", message: "{count} months", values: { count } });
  return i18n._({ id: "{count} years", message: "{count} years", values: { count } });
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
    return i18n._({ id: "Trial ends {day}", message: "Trial ends {day}", values: { day } });
  return date.kind === "ends"
    ? i18n._({ id: "Ends {day}", message: "Ends {day}", values: { day } })
    : i18n._({ id: "Renews {day}", message: "Renews {day}", values: { day } });
}
