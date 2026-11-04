import type { SpendingCurrency, SpendingPeriod } from "@rakazo/contracts";
import { wallClock, zonedDateTime } from "./cron.js";

// A symbol another currency shares is read as the one listed: every other dollar or pound is worth
// less, so a page in one of them is over-counted against the limit, never under-counted.
const CURRENCY_MARKS: Array<[RegExp, SpendingCurrency]> = [
  [/\$|\bUSD\b/i, "usd"],
  [/€|\bEUR\b/i, "eur"],
  [/£|\bGBP\b/i, "gbp"],
  [/₪|\b(?:ILS|NIS)\b|ש["״]ח/i, "ils"],
];
// The page browser's own number pattern: thousands may be grouped with spaces, as in "1 234,56".
const NUMBER = /\d(?:[\d.,]|[ \u00a0\u202f](?=\d{3}))*/g;
const MAX_AMOUNT = 1_000_000_000_000;

/**
 * An amount a checkout page shows, such as "$1,234.56", "1 234,56 €" or "₪50", in minor units and
 * its currency. Null when it names no currency a limit can be set in, more than one, or no single
 * number. A separator followed by one or two digits is the decimal point; any other separator
 * groups thousands, so an ambiguous "$1.234" reads as 1234 dollars, the larger reading.
 */
export function parsePageAmount(
  text: string,
): { amount: number; currency: SpendingCurrency } | null {
  const currencies = new Set(
    CURRENCY_MARKS.filter(([mark]) => mark.test(text)).map(([, currency]) => currency),
  );
  // A yen or any other currency sign beside one of ours leaves the currency in doubt.
  if (currencies.size !== 1 || /[¥₩₹₽₺₴฿₫]/.test(text)) return null;
  const numbers = text.match(NUMBER) ?? [];
  if (numbers.length !== 1) return null;
  const amount = minorUnits(numbers[0]!);
  return amount === null ? null : { amount, currency: [...currencies][0]! };
}

// A separator followed by one or two digits is the decimal point; any other separator groups thousands.
function minorUnits(number: string): number | null {
  const digits = number.replace(/[\s\u00a0\u202f]/g, "").replace(/[.,]+$/, "");
  const separator = Math.max(digits.lastIndexOf("."), digits.lastIndexOf(","));
  const fraction = separator >= 0 ? digits.slice(separator + 1) : "";
  const decimal = separator >= 0 && fraction.length >= 1 && fraction.length <= 2;
  const whole = (decimal ? digits.slice(0, separator) : digits).replace(/[.,]/g, "");
  const amount = Number(whole || "0") * 100 + (decimal ? Number(fraction.padEnd(2, "0")) : 0);
  return Number.isSafeInteger(amount) && amount <= MAX_AMOUNT ? amount : null;
}

/** The most a spending limit can be set to, in minor units. */
export const MAX_SPENDING_LIMIT = 100_000_000;

/**
 * A limit amount the user typed, such as "200", "1,000" or "12,50", in minor units. Null for
 * anything else, zero, or more than the largest limit.
 */
export function parseLimitInput(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d(?:[\d.,\s\u00a0\u202f]*\d)?[.,]?$/.test(trimmed)) return null;
  const amount = minorUnits(trimmed);
  return amount && amount <= MAX_SPENDING_LIMIT ? amount : null;
}

/**
 * When the current period of a spending limit began: midnight today, Monday's midnight or the
 * first of the month in the user's timezone, or when the limit was set for one that never resets.
 */
export function spendingPeriodStart(
  period: SpendingPeriod,
  startsAt: Date,
  timezone: string | null | undefined,
  now = new Date(),
): Date {
  if (period === "none") return startsAt;
  const zone = timezone || "UTC";
  const [year, month, day] = wallClock(now, zone).slice(0, 10).split("-").map(Number) as [
    number,
    number,
    number,
  ];
  const back =
    period === "week" ? (new Date(Date.UTC(year, month - 1, day)).getUTCDay() + 6) % 7 : 0;
  const first = new Date(Date.UTC(year, month - 1, period === "month" ? 1 : day - back));
  return zonedDateTime(first.toISOString().slice(0, 10), zone) ?? first;
}

/** An amount in minor units as money, such as "$12.50". */
export function formatMinorAmount(amount: number, currency: string, locale = "en-US"): string {
  try {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency: currency.toUpperCase(),
    }).format(amount / 100);
  } catch {
    return `${(amount / 100).toFixed(2)} ${currency.toUpperCase()}`;
  }
}
