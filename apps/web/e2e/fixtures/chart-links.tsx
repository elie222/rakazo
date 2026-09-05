import { setupI18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { createRoot } from "react-dom/client";
import { ChartBlockView } from "../../src/pages/shell/message-cards";
import "../../src/styles.css";

const params = new URLSearchParams(location.search);
const href = params.get("href") ?? "#details";
const i18n = setupI18n({ locale: "en", messages: { en: {} } });

createRoot(document.getElementById("root")!).render(
  <I18nProvider i18n={i18n}>
    <main className="min-h-screen bg-background p-8 text-foreground">
      <ChartBlockView
        name="chart.png"
        spec={{
          title: "Linked chart",
          marks: [
            {
              type: "dot",
              options: {
                x: "x",
                y: "y",
                href: "url",
                fill: "currentColor",
                r: 12,
                tip: params.get("inspect") === "1",
              },
            },
          ],
        }}
        data={[{ x: 1, y: 1, url: href }]}
      />
      <div id="details">Chart details</div>
    </main>
  </I18nProvider>,
);
