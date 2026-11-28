// The real message box with the model button beside Send, for layout checks at any width, in
// either direction (?lang=he), with a short or long model name (?model=long) and an optional
// detail such as the thinking level (?detail=), and while a reply is running (?running=1).
import { I18nProvider } from "@lingui/react";
import type { ChatModelChoice } from "@rakazo/core";
import { modelMark } from "@rakazo/core";
import { createRef } from "react";
import { createRoot } from "react-dom/client";
import { bootstrapI18n, i18n } from "../../src/lib/locale/i18n";
import { normalizeUiLocale } from "../../src/lib/locale/ui-locale";
import { ChatModelPicker } from "../../src/pages/shell/chat/chat-model-picker";
import { Composer } from "../../src/pages/shell/composer/composer";
import "../../src/styles.css";

const params = new URLSearchParams(location.search);
const locale = normalizeUiLocale(params.get("lang") ?? "en");
const long = params.get("model") === "long";
const detail = params.get("detail") ?? undefined;
const running = params.get("running") === "1";

const choices: ChatModelChoice[] = [
  long
    ? {
        key: "openrouter:vendor/very-long-model-name-extended-context-preview-2026-11-01",
        label: "Vendor Very Long Model Name Extended Context Preview 2026-11-01",
        provider: "openrouter",
        modelId: "vendor/very-long-model-name-extended-context-preview-2026-11-01",
      }
    : { key: "openai:e2e-fast", label: "GPT Fast", provider: "openai", modelId: "e2e-fast" },
  { key: "openai:e2e-smart", label: "GPT Smart", provider: "openai", modelId: "e2e-smart" },
];

function Fixture() {
  return (
    <main className="flex min-h-screen flex-col justify-end bg-background text-foreground">
      <div className="relative z-30">
        <Composer
          artifactTarget={{ botId: "bot-1" }}
          activeName="Ada"
          running={running}
          pendingAttachments={[]}
          attachmentNotice={null}
          sendError={null}
          onOpenModels={() => {}}
          onOpenConnections={() => {}}
          onOpenBilling={() => {}}
          runError={null}
          runErrorId={null}
          onRunErrorPresented={() => {}}
          onDismissError={() => {}}
          sending={false}
          fileInputRef={createRef()}
          onAttachmentPick={() => true}
          onRemoveAttachment={() => {}}
          onSend={async () => true}
          onStop={async () => {}}
          draftKey="fixture:composer-model-button"
          enterToSend
          modelPicker={
            <ChatModelPicker
              compact
              choices={choices}
              value={choices[0]!.key}
              mark={modelMark(choices[0]!)}
              detail={detail}
              onChange={() => {}}
            />
          }
        />
      </div>
    </main>
  );
}

void bootstrapI18n(locale).then(() => {
  createRoot(document.getElementById("root")!).render(
    <I18nProvider i18n={i18n}>
      <Fixture />
    </I18nProvider>,
  );
});
