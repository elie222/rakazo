import { useLingui } from "@lingui/react/macro";
import type { SpendingStatus } from "@rakazo/contracts";
import { router } from "expo-router";
import type { ReactNode } from "react";
import { useUiLocale } from "../lib/i18n";
import { accountRpcQuery } from "../lib/query";
import { useScreenQuery } from "../lib/screen-query";
import { spendingLimitSummary } from "../lib/spending-limit";
import { SettingsRow } from "./settings-group";

/** The spending limit and what counts against it, read again each time the screen is shown. */
export function useSpendingStatus(): SpendingStatus | null {
  // A failed read leaves the row out; the setting is not needed to use the app.
  return useScreenQuery(accountRpcQuery("spendingLimit/get")).data ?? null;
}

/** The spending limit in account settings. Render it only once `status.shown`. */
export function SpendingLimitRow({
  status,
  disabled = false,
  leading,
}: {
  status: SpendingStatus;
  disabled?: boolean;
  leading?: ReactNode;
}) {
  const { t } = useLingui();
  const locale = useUiLocale();
  return (
    <SettingsRow
      chevron="right"
      disabled={disabled}
      leading={leading}
      onPress={() => router.push("/spending-limit")}
      title={t`Spending limit`}
      value={status.limit ? spendingLimitSummary(locale, status.limit) : t`None`}
    />
  );
}
