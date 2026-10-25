import { I18nProvider } from "@lingui/react";
import type { ProductEvent } from "@rakazo/contracts";
import { withLiveStreamingProgress } from "@rakazo/core";
import { createRoot } from "react-dom/client";
import { bootstrapI18n, i18n } from "../../src/lib/i18n";
import { setResponseStreamingPreference } from "../../src/lib/response-streaming";
import "../../src/styles.css";
import { FixtureTranscript, reduceThreadEvents } from "./thread-fixture";

const params = new URLSearchParams(location.search);
const streamResponses = params.get("stream") !== "off";
const phase = params.get("phase") === "done" ? "done" : "live";

const USER_TEXT = "What's the capital of Portugal?";
const LIVE_TOKENS = "Lisbon is the cap";
const COMPLETE_TEXT = "Lisbon is the capital of Portugal.";

const liveTurn: Partial<ProductEvent>[] = [
  {
    type: "thread.message.created",
    payload: { messageId: "user-1", role: "user", blocks: [{ kind: "text", text: USER_TEXT }] },
  },
  { type: "run.started", payload: { trigger: "user" } },
  { type: "agent.tool.called", payload: { name: "browser" } },
  { type: "thread.progress", payload: { text: LIVE_TOKENS, streaming: true } },
];
const finishedTurn: Partial<ProductEvent>[] = [
  ...liveTurn,
  {
    type: "thread.message.created",
    payload: {
      messageId: "bot-final",
      role: "bot",
      blocks: [{ kind: "text", text: COMPLETE_TEXT }],
    },
  },
  { type: "run.completed" },
];

function fixtureNote(): string {
  if (!streamResponses && phase === "live") {
    return "Fixture: thread reducer · Stream replies off · mid-turn (no live tokens)";
  }
  if (!streamResponses && phase === "done") {
    return "Fixture: thread reducer · Stream replies off · finished assistant message";
  }
  return "Fixture: thread reducer · Stream replies on · mid-turn token progress";
}

const snapshot = reduceThreadEvents(phase === "done" ? finishedTurn : liveTurn);
const messages = withLiveStreamingProgress(snapshot, streamResponses)?.messages ?? [];

void bootstrapI18n("en").then(() => {
  setResponseStreamingPreference(streamResponses ? "on" : "off");
  createRoot(document.getElementById("root")!).render(
    <I18nProvider i18n={i18n}>
      <FixtureTranscript
        messages={messages}
        running={snapshot.run?.status === "running"}
        showToolActivity
        header={
          <p
            data-testid="fixture-note"
            className="px-4 pt-5 text-[12.5px] text-muted-foreground/80 md:px-7"
          >
            {fixtureNote()}
          </p>
        }
      />
    </I18nProvider>,
  );
});
