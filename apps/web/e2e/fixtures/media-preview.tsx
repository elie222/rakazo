import { I18nProvider } from "@lingui/react";
import { createRoot } from "react-dom/client";
import { ArtifactFileCard } from "../../src/components/ArtifactFileCard";
import { bootstrapI18n, i18n } from "../../src/lib/i18n";
import "../../src/styles.css";

const params = new URLSearchParams(location.search);
const audio = params.has("audio");
const large = params.has("large");
await bootstrapI18n();
createRoot(document.getElementById("root")!).render(
  <I18nProvider i18n={i18n}>
    <main className="min-h-screen bg-background p-8 text-foreground">
      <div className="max-w-md">
        <ArtifactFileCard
          target={{ botId: "demo-bot" }}
          artifactId={large ? "demo-archive" : audio ? "demo-audio" : "demo-video"}
          name={large ? "backup.zip" : audio ? "audio.wav" : "generated-video.mp4"}
          mimeType={large ? "application/zip" : audio ? "audio/wav" : "video/mp4"}
          size={large ? 1610612736 : audio ? 16044 : 902}
        />
      </div>
    </main>
  </I18nProvider>,
);
