import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { type ReactNode, useEffect, useState } from "react";
import { bootstrapI18n, getActiveUiLocale } from "../lib/i18n";
import { resolveUiLocale } from "../lib/ui-locale";

export function I18nBootstrap({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(() => i18n.locale === getActiveUiLocale());

  useEffect(() => {
    let cancelled = false;
    // activateUiLocale already falls back to English on catalog failure.
    void bootstrapI18n(resolveUiLocale()).finally(() => {
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
