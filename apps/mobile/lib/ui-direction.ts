import { textDirectionForLocale } from "@rakazo/core";
import { reloadAppAsync } from "expo";
import { I18nManager, Platform } from "react-native";

let directionReloadScheduled = false;

export function resolveMobileUiLocale(): string {
  return Intl.DateTimeFormat().resolvedOptions().locale || "en";
}

/**
 * Apply layout direction for a UI locale.
 * Default is English (LTR): mobile UI locales are en / zh-CN only.
 * Do not pass the device locale here — that fights bootstrapI18n on RTL phones
 * and can reload-loop when the resolved UI locale stays LTR.
 */
export function applyMobileUiDirection(locale = "en") {
  const rtl = textDirectionForLocale(locale) === "rtl";
  // Always allow RTL so a later locale switch can take effect after relaunch.
  I18nManager.allowRTL(true);
  if (I18nManager.isRTL === rtl) return rtl;

  // forceRTL persists and only takes effect after reload / next cold start.
  I18nManager.forceRTL(rtl);
  if (!directionReloadScheduled && Platform.OS !== "web") {
    directionReloadScheduled = true;
    queueMicrotask(() => {
      void reloadAppAsync("ui-direction").catch(() => {
        directionReloadScheduled = false;
      });
    });
  }
  return rtl;
}
