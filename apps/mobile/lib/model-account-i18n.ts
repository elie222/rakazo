import { translate as translateCatalog } from "@rakazo/core";
import { useCallback } from "react";
import { useI18n as useAppI18n } from "./i18n/i18n";
import { MODEL_ACCOUNT_MESSAGES } from "./model-account-messages";

export function useI18n() {
  const { locale, t: translate } = useAppI18n();
  const t = useCallback(
    (message: string, values?: Record<string, string | number>) =>
      MODEL_ACCOUNT_MESSAGES[locale]?.[message]
        ? translateCatalog(MODEL_ACCOUNT_MESSAGES[locale], message, values)
        : translate(message, values),
    [locale, translate],
  );
  return { locale, t };
}
