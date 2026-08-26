import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { type ReactNode, useEffect, useState } from "react";
import { activateUiLocale, bootstrapI18n, getActiveUiLocale } from "../lib/i18n";
import { resolveUiLocale, type UiLocale } from "../lib/ui-locale";

export function I18nBootstrap({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(() => i18n.locale === getActiveUiLocale());

  useEffect(() => {
    let cancelled = false;
    void bootstrapI18n(resolveUiLocale())
      .catch(async () => {
        // Catalog fetch can fail on a stale deploy; never blank the whole app.
        if (resolveUiLocale() === "en") throw new Error("english catalog unavailable");
        return activateUiLocale("en" satisfies UiLocale);
      })
      .catch(() => {
        // Last resort: activate empty English so chrome falls back to source messages.
        i18n.load("en", {});
        i18n.activate("en");
        return "en" as UiLocale;
      })
      .then(() => {
        if (!cancelled) setReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!ready) {
    return (
      <div
        className="grid h-full place-items-center text-[#6C6C70]"
        data-rakazo-app-state="i18n-pending"
      />
    );
  }

  return <I18nProvider i18n={i18n}>{children}</I18nProvider>;
}
