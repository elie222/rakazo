import { i18n } from "@lingui/core";
import { formatRelativeTime as formatInLocale } from "@rakazo/i18n/activity";

/** Relative time in the active UI language. */
export function formatRelativeTime(iso: string, now = new Date()): string {
  return formatInLocale(iso, i18n.locale || "en", now);
}
