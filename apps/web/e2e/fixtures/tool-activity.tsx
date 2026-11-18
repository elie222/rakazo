import { I18nProvider } from "@lingui/react";
import type { MessageBlock, ThreadMessage, ToolCallRecord } from "@rakazo/contracts";
import { QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { ToolCallExplanations } from "../../src/components/messages/RunToolCallDetails";
import {
  ToolActivityDisclosure,
  ToolSteps,
} from "../../src/components/messages/ToolActivityDisclosure";
import { toolActivityPreference } from "../../src/lib/chat/tool-activity-preference";
import { bootstrapI18n, i18n } from "../../src/lib/locale/i18n";
import { queryClient } from "../../src/lib/query/query";
import { rpc } from "../../src/lib/query/rpc";
import { SettingsOverlay } from "../../src/pages/settings/SettingsOverlay";
import "../../src/styles.css";
import { FixtureTranscript } from "./thread-fixture";

const params = new URLSearchParams(location.search);
const requested = params.get("view");
const view = requested === "settings" || requested === "records" ? requested : "thread";
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

const NOTE_TEXT = "Anna is free all Tuesday afternoon.";

const stepRows = STEP_LABELS.map((label) => ({
  label,
  count: 1,
  // A finished reply keeps what the bot wrote before a step on that step.
  ...(!live && label === "Check conflicts" ? { note: NOTE_TEXT } : {}),
}));

const stepsBlock: MessageBlock = {
  kind: "steps",
  steps: stepRows,
  ...(live ? {} : { durationMs: 12_400 }),
};

const createdAt = "2026-08-16T00:00:01.000Z";

// A live run that has only called tools so far, or the finished reply with its tool card.
const messages: ThreadMessage[] = [
  {
    id: "user-1",
    threadId: "thread-1",
    seq: 1,
    role: "user",
    blocks: [{ kind: "text", text: USER_TEXT }],
    createdAt,
  },
  {
    id: live ? "progress:run-1" : "bot-reply",
    threadId: "thread-1",
    seq: 2,
    role: "bot",
    blocks: live ? [stepsBlock] : [stepsBlock, { kind: "text", text: REPLY_TEXT }],
    botId: "bot-1",
    runId: "run-1",
    createdAt,
  },
];

/** What a run kept of two of its calls: one that failed, and one whose result was cut short. */
const keptCalls: ToolCallRecord[] = [
  {
    executionId: "call-1",
    tool: "Search inbox",
    durationMs: 1840,
    outcome: "failed",
    arguments: '{"query":"from:anna is:unread","limit":20}',
    error: "Mailbox authorization expired. Reconnect the account to read it.",
  },
  {
    executionId: "call-2",
    tool: "Read events",
    durationMs: 240,
    outcome: "succeeded",
    arguments: '{"calendar":"Team","days":30}',
    resultBytes: 184_320,
    resultShortened: true,
  },
];

function RecordsFixture() {
  return (
    <main className="mx-auto max-w-2xl p-6">
      <ToolActivityDisclosure live={false} stepCount={8} durationMs={12_400}>
        <ToolSteps steps={stepRows} />
        <ToolCallExplanations calls={keptCalls} />
      </ToolActivityDisclosure>
    </main>
  );
}

function ThreadFixture() {
  const showToolActivity = toolActivityPreference.use();
  return (
    <FixtureTranscript messages={messages} running={live} showToolActivity={showToolActivity} />
  );
}

function SettingsFixture() {
  return (
    <main className="min-h-screen bg-background text-foreground">
      <SettingsOverlay
        shellRpc={rpc}
        email="owner@example.test"
        name="Owner"
        memoryConfig={null}
        onMemoryConfigChange={() => {}}
        timezone="UTC"
        onTimezoneChange={async () => {}}
        labs={[]}
        labsAvailable={[]}
        onLabsChange={async () => {}}
        onClose={() => {}}
        section="general"
        onSectionChange={() => {}}
      />
    </main>
  );
}

void bootstrapI18n("en").then(() => {
  createRoot(document.getElementById("root")!).render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider i18n={i18n}>
        {view === "settings" ? (
          <SettingsFixture />
        ) : view === "records" ? (
          <RecordsFixture />
        ) : (
          <ThreadFixture />
        )}
      </I18nProvider>
    </QueryClientProvider>,
  );
});
