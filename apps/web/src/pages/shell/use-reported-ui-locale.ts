import { reportUiLocale } from "@rakazo/core";
import { bestEffort } from "@rakazo/logging/best-effort";
import { useEffect, useRef } from "react";
import { i18n } from "../../lib/locale/i18n";
import { normalizeUiLocale } from "../../lib/locale/ui-locale";
import type { createSpaceRpc } from "../../lib/query/rpc";

/**
 * Keeps the account's saved app language current, so emails are written in it. `saved` is
 * undefined until the bootstrap arrives, and on servers that predate it.
 */
export function useReportedUiLocale(
  rpc: ReturnType<typeof createSpaceRpc>,
  saved: string | null | undefined,
): void {
  const reported = useRef<{ locale: string; failed: boolean } | null>(null);
  useEffect(() => {
    if (saved === undefined) return;
    const report = () => {
      // Lingui announces a change before the app records it, so read its own locale.
      const locale = i18n.locale;
      if (!locale) return;
      const last = reported.current;
      if (last ? last.locale === locale && !last.failed : locale === saved) return;
      const attempt = { locale, failed: false };
      reported.current = attempt;
      const save = reportUiLocale(
        () => normalizeUiLocale(i18n.locale),
        (locale) => rpc.preferences.update({ locale }),
      ).catch((error: unknown) => {
        // A later report can retry; an older failure cannot mark a newer attempt as failed.
        attempt.failed = true;
        throw error;
      });
      void bestEffort("save the reported UI locale", save);
    };
    report();
    let active = true;
    const unsubscribe = i18n.on("change", () => {
      // Loading a catalog also emits change, just before the new language is activated.
      queueMicrotask(() => {
        if (active) report();
      });
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [rpc, saved]);
}
