import { I18nProvider } from "@lingui/react";
import { createRoot } from "react-dom/client";
import { ArtifactFileCard } from "../../src/components/ArtifactFileCard";
import { bootstrapI18n, i18n } from "../../src/lib/i18n";
import "../../src/styles.css";

await bootstrapI18n();
createRoot(document.getElementById("root")!).render(
  <I18nProvider i18n={i18n}>
    <main className="min-h-screen bg-background p-8 text-foreground">
      <ArtifactFileCard
        target={{ botId: "demo-bot" }}
        artifactId="demo-video"
        name="generated-video.mp4"
        mimeType="video/mp4"
        size={902}
      />
    </main>
  </I18nProvider>,
);
