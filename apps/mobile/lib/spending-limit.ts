import { ph, t } from "@lingui/core/macro";
import type { SpendingLimit } from "@rakazo/contracts";
import { formatMinorAmount } from "@rakazo/core";
import { dateLocaleForUi } from "./i18n";
import type { UiLocale } from "./ui-locale";

/** The limit as one line, such as "$200.00 a month". */
export function spendingLimitSummary(
  locale: UiLocale,
  { amount, currency, period }: SpendingLimit,
): string {
  const shown = formatMinorAmount(amount, currency, dateLocaleForUi(locale));
  if (period === "day") return t`${ph({ amount: shown })} a day`;
  if (period === "week") return t`${ph({ amount: shown })} a week`;
  if (period === "month") return t`${ph({ amount: shown })} a month`;
  return t`${ph({ amount: shown })} in total`;
}

/** What counts against the limit now, such as "$23.40 spent this month". */
export function spendingSpentSummary(
  locale: UiLocale,
  spent: number,
  { currency, period }: SpendingLimit,
): string {
  const shown = formatMinorAmount(spent, currency, dateLocaleForUi(locale));
  if (period === "day") return t`${ph({ amount: shown })} spent today`;
  if (period === "week") return t`${ph({ amount: shown })} spent this week`;
  if (period === "month") return t`${ph({ amount: shown })} spent this month`;
  return t`${ph({ amount: shown })} spent`;
}
