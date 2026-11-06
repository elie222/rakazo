import { I18nProvider } from "@lingui/react";
import type { MessageBlock, ThreadMessage, ToolCallRecord } from "@rakazo/contracts";
import { QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { bootstrapI18n, i18n } from "../../src/lib/i18n";
import { queryClient } from "../../src/lib/query";
import { rpc } from "../../src/lib/rpc";
import { toolActivityPreference } from "../../src/lib/tool-activity-preference";
import { replayToolCallRecords } from "../../src/lib/tool-call-records.fixture";
import { SettingsOverlay } from "../../src/pages/SettingsOverlay";
import "../../src/styles.css";
import { FixtureTranscript } from "./thread-fixture";

const params = new URLSearchParams(location.search);
const view = params.get("view") === "settings" ? "settings" : "thread";
const live = params.get("phase") === "live";

const USER_TEXT = "Find a free slot on Tuesday.";
const REPLY_TEXT = "Tuesday at 2 pm is free.";
/** Each call: what the row says about it, how long it took, and what it returned. */
const STEPS: {
  label: string;
  detail: string;
  durationMs: number;
  output: string;
  outcome?: "error";
  command?: string;
}[] = [
  {
    label: "Open calendar",
    detail: "Work",
    durationMs: 310,
    output: "Opened Work (14 events this week).",
  },
  {
    label: "Read events",
    detail: "Tuesday",
    durationMs: 1_200,
    output: "09:00 Standup\n11:00 Design review\n15:30 1:1 with Sam",
  },
  { label: "Search inbox", detail: "from:anna tuesday", durationMs: 2_100, output: "2 messages." },
  {
    label: "Read message",
    detail: "Re: Tuesday?",
    durationMs: 640,
    output: "Anna: Any time after lunch works for me, before 4.",
  },
  {
    label: "Shell",
    detail: "TZ=Europe/Berlin date -d '2026-08-18 14:00 America/New_York'",
    command: "TZ=Europe/Berlin date -d '2026-08-18 14:00 America/New_York'",
    durationMs: 90,
    output: "Tue Aug 18 20:00:00 CEST 2026",
  },
  {
    label: "Compare calendars",
    detail: "Anna, me",
    durationMs: 2_800,
    outcome: "error",
    output: "",
  },
  { label: "Draft invite", detail: "Tuesday 2 pm", durationMs: 1_500, output: "Draft saved." },
  // Only a shell prints while it runs, so the live run's last call is one.
  {
    label: "Shell",
    detail: 'cal conflicts "Tuesday 2 pm"',
    command: 'cal conflicts "Tuesday 2 pm"',
    durationMs: 3_700,
    output: "No conflicts.",
  },
];

const NOTE_TEXT = "Anna is free all Tuesday afternoon.";

const stepsBlock: MessageBlock = {
  kind: "steps",
  steps: STEPS.map((step, index) => {
    const running = live && index === STEPS.length - 1;
    return {
      label: step.label,
      count: 1,
      executionId: `call-${index + 1}`,
      detail: step.detail,
      ...(running ? {} : { outcome: step.outcome ?? "ok", durationMs: step.durationMs }),
      // A finished reply keeps what the bot wrote before a step on that step.
      ...(!live && index === STEPS.length - 1 ? { note: NOTE_TEXT } : {}),
    };
  }),
  ...(live ? {} : { durationMs: 12_400 }),
};

// What the thread's events said about each call; the live run's last call is still printing.
replayToolCallRecords(
  "run-1",
  STEPS.map((step, index): ToolCallRecord => {
    const running = live && index === STEPS.length - 1;
    return {
      executionId: `call-${index + 1}`,
      name: step.label.toLowerCase().replace(/ /g, "_"),
      status: running ? "running" : "done",
      ...(running
        ? { output: "Checking 3 calendars" }
        : { output: step.output, durationMs: step.durationMs }),
      ...(step.command ? {} : { input: JSON.stringify({ query: step.detail }, null, 2) }),
      ...(step.outcome === "error"
        ? { outcome: "error", error: "Anna's calendar is not shared." }
        : running
          ? {}
          : { outcome: "succeeded" }),
      ...(step.command ? { command: step.command, exitCode: running ? null : 0 } : {}),
    };
  }),
);

// A live run started moments ago, so its header counts up from a believable time.
const createdAt = live ? new Date(Date.now() - 12_400).toISOString() : "2026-08-16T00:00:01.000Z";

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
        onUsageOpen={() => {}}
        timezone="UTC"
        onTimezoneChange={async () => {}}
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
        {view === "settings" ? <SettingsFixture /> : <ThreadFixture />}
      </I18nProvider>
    </QueryClientProvider>,
  );
});
