import type { SpendingLimit } from "@rakazo/contracts";
import { formatMinorAmount } from "@rakazo/core";
import type { t as translate } from "./i18n";
import { dateLocaleForUi } from "./i18n";
import type { UiLocale } from "./ui-locale";

/** The limit as one line, such as "$200.00 a month". */
export function spendingLimitSummary(
  t: typeof translate,
  locale: UiLocale,
  { amount, currency, period }: SpendingLimit,
): string {
  const shown = formatMinorAmount(amount, currency, dateLocaleForUi(locale));
  if (period === "day") return t("{amount} a day", { amount: shown });
  if (period === "week") return t("{amount} a week", { amount: shown });
  if (period === "month") return t("{amount} a month", { amount: shown });
  return t("{amount} in total", { amount: shown });
}

/** What counts against the limit now, such as "$23.40 spent this month". */
export function spendingSpentSummary(
  t: typeof translate,
  locale: UiLocale,
  spent: number,
  { currency, period }: SpendingLimit,
): string {
  const shown = formatMinorAmount(spent, currency, dateLocaleForUi(locale));
  if (period === "day") return t("{amount} spent today", { amount: shown });
  if (period === "week") return t("{amount} spent this week", { amount: shown });
  if (period === "month") return t("{amount} spent this month", { amount: shown });
  return t("{amount} spent", { amount: shown });
}
