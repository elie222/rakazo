import { I18nProvider } from "@lingui/react";
import type { MessageBlock } from "@rakazo/contracts";
import { useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import {
  StandaloneToolActivity,
  ToolOnlyNarration,
} from "../../src/components/ToolActivityDisclosure";
import { bootstrapI18n, i18n } from "../../src/lib/i18n";
import {
  getToolActivityEnabled,
  subscribeToolActivity,
} from "../../src/lib/tool-activity-preference";
import {
  isToolOnlyNarration,
  renderableMessageBlocks,
  toolStepCount,
} from "../../src/lib/tool-activity-view";
import { SettingsOverlay } from "../../src/pages/SettingsOverlay";
import "../../src/styles.css";

const params = new URLSearchParams(location.search);
const view = params.get("view") === "settings" ? "settings" : "thread";
const live = params.get("phase") === "live";

const USER_TEXT = "Find a free slot on Tuesday.";
const REPLY_TEXT = "Tuesday at 2 pm is free.";
const STEP_LABELS = [
  "Open calendar",
  "Read events",
  "Search inbox",
  "Read message",
  "Check time zones",
  "Compare calendars",
  "Draft invite",
  "Check conflicts",
];

const stepsBlock: MessageBlock = {
  kind: "steps",
  steps: STEP_LABELS.map((label) => ({ label, count: 1 })),
  ...(live ? {} : { durationMs: 12_400 }),
};

// A live run that has only called tools so far, or the finished reply with its tool card.
const botBlocks: MessageBlock[] = live
  ? [stepsBlock]
  : [stepsBlock, { kind: "text", text: REPLY_TEXT }];

function BotMessage({ blocks }: { blocks: MessageBlock[] }) {
  const showToolActivity = useSyncExternalStore(subscribeToolActivity, getToolActivityEnabled);
  const visible = renderableMessageBlocks(blocks, showToolActivity);
  if (visible.length === 0) return null;
  if (isToolOnlyNarration(blocks, showToolActivity)) {
    return <ToolOnlyNarration blocks={visible} live={live} />;
  }
  return (
    <>
      {visible.map((block, i) => {
        if (block.kind === "steps") {
          return (
            <StandaloneToolActivity
              key={i}
              live={live}
              steps={block.steps}
              stepCount={toolStepCount(block.steps)}
              durationMs={block.durationMs}
            />
          );
        }
        if (block.kind !== "text") return null;
        return (
          <div key={i} className="flex justify-start">
            <div
              data-testid="message-bot-bubble"
              className="max-w-[74%] rounded-[20px] bg-muted px-[18px] py-3 text-[15.5px] leading-[1.5]"
            >
              {block.text}
            </div>
          </div>
        );
      })}
    </>
  );
}

function ThreadFixture() {
  return (
    <main className="min-h-screen bg-background px-4 py-6 text-foreground md:px-8 md:py-8">
      <p data-testid="fixture-note" className="pb-4 text-[12.5px] text-muted-foreground/80">
        {`Fixture: tool activity · ${live ? "live run" : "finished run"}`}
      </p>
      <div data-testid="transcript" className="flex flex-col gap-3">
        <div className="flex justify-end">
          <div
            data-testid="message-user-bubble"
            className="max-w-[74%] rounded-[20px] bg-primary px-[18px] py-3 text-[15.5px] text-primary-foreground"
          >
            {USER_TEXT}
          </div>
        </div>
        <BotMessage blocks={botBlocks} />
      </div>
    </main>
  );
}

function SettingsFixture() {
  return (
    <main className="min-h-screen bg-background text-foreground">
      <SettingsOverlay
        email="owner@example.test"
        name="Owner"
        avatarStyle="robot"
        onAvatarStyleChange={() => Promise.resolve()}
        memoryConfig={null}
        onMemoryConfigChange={() => {}}
        onClose={() => {}}
      />
    </main>
  );
}

void bootstrapI18n("en").then(() => {
  createRoot(document.getElementById("root")!).render(
    <I18nProvider i18n={i18n}>
      {view === "settings" ? <SettingsFixture /> : <ThreadFixture />}
    </I18nProvider>,
  );
});
