import { I18nProvider } from "@lingui/react";
import { ChatMarkdown } from "@rakazo/chat-ui/web";
import type { ProductEvent, ThreadMessage, ThreadSnapshot } from "@rakazo/contracts";
import { isToolActivityBlock, withLiveStreamingProgress } from "@rakazo/core";
import { DEFAULT_GROK_BOT_COLOR } from "@rakazo/ui-web";
import { createRoot } from "react-dom/client";
import { ActiveBotGlyph } from "../../src/components/ai/CollaborationMarker";
import { bootstrapI18n, i18n } from "../../src/lib/i18n";
import { setResponseStreamingPreference } from "../../src/lib/response-streaming";
import { reduceThreadSnapshot } from "../../src/lib/thread-events";
import { SettingsOverlay } from "../../src/pages/SettingsOverlay";
import "../../src/styles.css";

const params = new URLSearchParams(location.search);
const view = params.get("view") === "settings" ? "settings" : "thread";
const streamResponses = params.get("stream") !== "off";
const phase = params.get("phase") === "done" ? "done" : "live";

const USER_TEXT = "What's the capital of Portugal?";
const LIVE_TOKENS = "Lisbon is the cap";
const COMPLETE_TEXT = "Lisbon is the capital of Portugal.";

function productEvent(seq: number, overrides: Partial<ProductEvent>): ProductEvent {
  return {
    id: `event-${seq}`,
    spaceId: "workspace-1",
    threadId: "thread-1",
    botId: "bot-1",
    seq,
    type: "thread.progress",
    runId: "run-1",
    createdAt: "2026-08-16T00:00:01.000Z",
    payload: {},
    ...overrides,
  };
}

function emptySnapshot(): ThreadSnapshot {
  return {
    botId: "bot-1",
    threadId: "thread-1",
    cursor: 0,
    messages: [],
    olderCursor: null,
    run: null,
  };
}

/** Same thread.progress / message.created path the chat shell uses. */
function reduceComparableTurn(stream: boolean, turn: "live" | "done"): ThreadSnapshot {
  let snapshot = reduceThreadSnapshot(
    emptySnapshot(),
    productEvent(1, {
      type: "thread.message.created",
      payload: {
        messageId: "user-1",
        role: "user",
        blocks: [{ kind: "text", text: USER_TEXT }],
      },
    }),
  );
  snapshot = reduceThreadSnapshot(
    snapshot,
    productEvent(2, { type: "run.started", payload: { trigger: "user" } }),
  );
  snapshot = reduceThreadSnapshot(
    snapshot,
    productEvent(3, {
      type: "agent.tool.called",
      payload: { name: "browser" },
    }),
  );
  snapshot = reduceThreadSnapshot(
    snapshot,
    productEvent(4, {
      type: "thread.progress",
      payload: { text: LIVE_TOKENS, streaming: true },
    }),
  );
  if (turn === "done") {
    snapshot = reduceThreadSnapshot(
      snapshot,
      productEvent(5, {
        type: "thread.message.created",
        payload: {
          messageId: "bot-final",
          role: "bot",
          blocks: [{ kind: "text", text: COMPLETE_TEXT }],
        },
      }),
    );
    snapshot = reduceThreadSnapshot(snapshot, productEvent(6, { type: "run.completed" }));
  }
  return withLiveStreamingProgress(snapshot, stream) ?? emptySnapshot();
}

function fixtureNote(): string {
  if (view === "settings") {
    return `Fixture: Settings overlay · Stream replies ${streamResponses ? "on" : "off"}`;
  }
  if (!streamResponses && phase === "live") {
    return "Fixture: thread reducer · Stream replies off · mid-turn (no live tokens)";
  }
  if (!streamResponses && phase === "done") {
    return "Fixture: thread reducer · Stream replies off · finished assistant message";
  }
  return "Fixture: thread reducer · Stream replies on · mid-turn token progress";
}

function MessageRow({ message }: { message: ThreadMessage }) {
  const narration = message.blocks.filter(
    (block) => (block.kind === "text" || block.kind === "progress") && !isToolActivityBlock(block),
  );
  const activity = message.blocks.filter((block) => isToolActivityBlock(block));
  if (message.role === "user") {
    const text = narration
      .filter((block) => block.kind === "text")
      .map((block) => block.text)
      .join("");
    return (
      <div className="relative flex justify-end" data-message-id={message.id}>
        <div
          data-testid="message-user-bubble"
          className="max-w-full whitespace-pre-wrap wrap-anywhere rounded-[20px] bg-chat-user px-[18px] py-3 text-[15.5px] leading-[1.45] text-chat-user-foreground"
          dir="auto"
        >
          {text}
        </div>
      </div>
    );
  }
  if (narration.length === 0 && activity.length === 0) return null;
  return (
    <div className="relative flex flex-col items-start gap-2" data-message-id={message.id}>
      {activity.map((block, i) => (
        <div
          key={`${message.id}-activity-${i}`}
          data-testid="tool-activity"
          className="text-[13px] text-muted-foreground"
        >
          {block.kind === "steps"
            ? block.steps
                .map((step) => `${step.label}${step.count > 1 ? ` ×${step.count}` : ""}`)
                .join(" · ")
            : block.kind === "progress"
              ? block.text
              : null}
        </div>
      ))}
      {narration.length > 0 ? (
        <div
          data-testid="message-bot-bubble"
          className="max-w-full space-y-2.5 rounded-[20px] bg-muted px-[18px] py-3 text-[15.5px] leading-[1.5] text-foreground/90"
          dir="auto"
        >
          {narration.map((block, i) => (
            <div key={`${message.id}-${i}`}>
              <ChatMarkdown streaming={block.kind === "progress"}>{block.text}</ChatMarkdown>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ThreadFixture({ snapshot }: { snapshot: ThreadSnapshot }) {
  const running = snapshot.run?.status === "running";
  const hasLiveProgressText = snapshot.messages.some(
    (message) =>
      message.id.startsWith("progress:") &&
      message.blocks.some(
        (block) => block.kind === "progress" && !isToolActivityBlock(block) && Boolean(block.text),
      ),
  );
  return (
    <main className="flex min-h-screen flex-col justify-end bg-background px-4 py-5 text-foreground md:px-7 md:py-6">
      <p data-testid="fixture-note" className="mb-4 text-[12.5px] text-muted-foreground/80">
        {fixtureNote()}
      </p>
      <div data-testid="transcript" className="flex flex-col gap-3">
        {snapshot.messages.map((message) => (
          <MessageRow key={message.id} message={message} />
        ))}
        {running && !hasLiveProgressText ? (
          <ActiveBotGlyph
            bots={[{ botId: "bot-1", name: "Chief", color: DEFAULT_GROK_BOT_COLOR }]}
            label="Chief is working"
          />
        ) : null}
      </div>
    </main>
  );
}

function SettingsFixture() {
  return (
    <main className="min-h-screen bg-background text-foreground">
      <p data-testid="fixture-note" className="px-4 py-3 text-[12.5px] text-muted-foreground/80">
        {fixtureNote()}
      </p>
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
  setResponseStreamingPreference(streamResponses ? "on" : "off");
  createRoot(document.getElementById("root")!).render(
    <I18nProvider i18n={i18n}>
      {view === "settings" ? (
        <SettingsFixture />
      ) : (
        <ThreadFixture snapshot={reduceComparableTurn(streamResponses, phase)} />
      )}
    </I18nProvider>,
  );
});
