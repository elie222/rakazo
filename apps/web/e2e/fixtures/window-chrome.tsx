import { setupI18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { createRoot } from "react-dom/client";
import { messages } from "../../src/locales/en/messages.po";
import { WindowChrome } from "../../src/pages/WindowChrome";
import "../../src/styles.css";

const i18n = setupI18n({ locale: "en", messages: { en: messages } });
document.documentElement.dataset.theme = "dark";
createRoot(document.getElementById("root")!).render(
  <I18nProvider i18n={i18n}>
    <aside className="w-64 bg-sidebar p-3">
      <WindowChrome />
      <p className="mt-4">Window controls preview</p>
    </aside>
  </I18nProvider>,
);
