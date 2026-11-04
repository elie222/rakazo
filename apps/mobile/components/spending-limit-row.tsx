import type { SpendingStatus } from "@rakazo/contracts";
import { router, useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import { rpc } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { spendingLimitSummary } from "../lib/spending-limit";
import { SettingsRow } from "./settings-group";

/** The spending limit in account settings, once the user has a way to pay. */
export function SpendingLimitRow({ disabled = false }: { disabled?: boolean }) {
  const { t, locale } = useI18n();
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
  if (!status?.shown) return null;
  return (
    <SettingsRow
      chevron="right"
      disabled={disabled}
      onPress={() => router.push("/spending-limit")}
      title={t("Spending limit")}
      value={status.limit ? spendingLimitSummary(t, locale, status.limit) : t("None")}
    />
  );
}
