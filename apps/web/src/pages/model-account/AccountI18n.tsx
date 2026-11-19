import { setupI18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import type { ReactNode } from "react";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { i18n } from "../../lib/locale/i18n";

type Messages = Parameters<typeof i18n.load>[1];
const loaders = import.meta.glob<{ messages: Messages }>("./locales/*/messages.po");
const subscribe = (changed: () => void) => i18n.on("change", changed);
const localeSnapshot = () => i18n.locale || "en";

/** Feature catalogs follow the app locale without modifying the global catalogs. */
export function AccountI18n({ children }: { children: ReactNode }) {
  const locale = useSyncExternalStore(subscribe, localeSnapshot, localeSnapshot);
  const [loaded, setLoaded] = useState<{ locale: string; messages: Messages }>();
  useEffect(() => {
    let active = true;
    const loader =
      loaders[`./locales/${locale}/messages.po`] ?? loaders["./locales/en/messages.po"]!;
    void loader().then(
      ({ messages }) => {
        if (active) setLoaded({ locale, messages });
      },
      () => {
        if (active) setLoaded({ locale, messages: {} });
      },
    );
    return () => {
      active = false;
    };
  }, [locale]);
  const scoped = useMemo(
    () =>
      setupI18n({
        locale,
        messages: {
          [locale]: { ...(loaded?.locale === locale ? loaded.messages : {}), ...i18n.messages },
        },
      }),
    [locale, loaded],
  );
  return <I18nProvider i18n={scoped}>{children}</I18nProvider>;
}
