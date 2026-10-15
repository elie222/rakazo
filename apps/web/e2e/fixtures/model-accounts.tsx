import { I18nProvider } from "@lingui/react";
import { createRoot } from "react-dom/client";
import { bootstrapI18n, i18n } from "../../src/lib/i18n";
import { ModelSettingsOverlay } from "../../src/pages/ModelSettingsOverlay";
import "../../src/styles.css";

await bootstrapI18n("en");
createRoot(document.getElementById("root")!).render(
  <I18nProvider i18n={i18n}>
    <main className="flex min-h-screen flex-col bg-background text-foreground">
      <ModelSettingsOverlay embedded onClose={() => undefined} />
    </main>
  </I18nProvider>,
);
