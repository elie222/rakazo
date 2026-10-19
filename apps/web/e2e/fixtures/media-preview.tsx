import { I18nProvider } from "@lingui/react";
import { createRoot } from "react-dom/client";
import { ArtifactFileCard } from "../../src/components/ArtifactFileCard";
import { bootstrapI18n, i18n } from "../../src/lib/i18n";
import "../../src/styles.css";

const audio = new URLSearchParams(location.search).has("audio");
await bootstrapI18n();
createRoot(document.getElementById("root")!).render(
  <I18nProvider i18n={i18n}>
    <main className="min-h-screen bg-background p-8 text-foreground">
      <div className="max-w-md">
        <ArtifactFileCard
          target={{ botId: "demo-bot" }}
          artifactId={audio ? "demo-audio" : "demo-video"}
          name={audio ? "audio.wav" : "generated-video.mp4"}
          mimeType={audio ? "audio/wav" : "video/mp4"}
          size={audio ? 16044 : 902}
        />
      </div>
    </main>
  </I18nProvider>,
);
