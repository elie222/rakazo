import { useLingui } from "@lingui/react/macro";
import type { SpendingStatus } from "@rakazo/contracts";
import { router, useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import { rpc } from "../lib/api";
import { useUiLocale } from "../lib/i18n";
import { spendingLimitSummary } from "../lib/spending-limit";
import { SettingsRow } from "./settings-group";

/** The spending limit and what counts against it, read again each time the screen is shown. */
export function useSpendingStatus(): SpendingStatus | null {
  const [status, setStatus] = useState<SpendingStatus | null>(null);
  useFocusEffect(
    useCallback(() => {
      let current = true;
      // A failed read leaves the row out; the setting is not needed to use the app.
      void rpc("spendingLimit/get")
        .then((next) => {
          if (current) setStatus(next);
        })
        .catch(() => undefined);
      return () => {
        current = false;
      };
    }, []),
  );
  return status;
}

/** The spending limit in account settings. Render it only once `status.shown`. */
export function SpendingLimitRow({
  status,
  disabled = false,
}: {
  status: SpendingStatus;
  disabled?: boolean;
}) {
  const { t } = useLingui();
  const locale = useUiLocale();
  return (
    <SettingsRow
      chevron="right"
      disabled={disabled}
      onPress={() => router.push("/spending-limit")}
      title={t`Spending limit`}
      value={status.limit ? spendingLimitSummary(locale, status.limit) : t`None`}
    />
  );
}
