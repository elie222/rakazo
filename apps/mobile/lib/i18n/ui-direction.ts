import { textDirectionForLocale } from "@rakazo/core";
import { reloadAppAsync } from "expo";
import { I18nManager, Platform } from "react-native";

let directionReloadScheduled = false;

export function resolveMobileUiLocale(): string {
  return Intl.DateTimeFormat().resolvedOptions().locale || "en";
}

/**
 * Apply layout direction for a UI locale.
 * Default is English (LTR): all supported mobile UI locales use LTR.
 * Do not pass the device locale here — that fights bootstrapI18n on RTL phones
 * and can reload-loop when the resolved UI locale stays LTR.
 */
export function applyMobileUiDirection(locale = "en") {
  const rtl = textDirectionForLocale(locale) === "rtl";
  // Allow RTL only for an RTL UI locale. React Native computes isRTL as
  // forced || (allowed && device language is RTL), so allowRTL(true) with forceRTL(false) left
  // isRTL true on an Arabic, Persian or Urdu phone whose UI is LTR (no UI locale for its
  // language): every start saw the mismatch and reloaded again, and the app never got past the
  // splash screen. A switch to an RTL locale allows RTL itself, then reloads.
  I18nManager.allowRTL(rtl);
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
