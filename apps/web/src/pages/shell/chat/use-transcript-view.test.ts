import type { Bot, ThreadSnapshot } from "@rakazo/contracts";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { useTranscriptView } from "./use-transcript-view";

function viewWithRun(status: string) {
  const snapshot = {
    botId: "bot-1",
    threadId: "thread-1",
    cursor: 1,
    messages: [],
    olderCursor: null,
    run: { id: "run-1", botId: "bot-1", userId: "user-1", status },
  } as unknown as ThreadSnapshot;
  let view: ReturnType<typeof useTranscriptView> | undefined;
  function Probe() {
    view = useTranscriptView({
      snapshot,
      inGroup: false,
      groupId: undefined,
      active: { id: "bot-1" } as Bot,
      activeGroup: undefined,
      bots: [],
      archivedBots: [],
      meId: "user-1",
    });
    return null;
  }
  renderToString(createElement(Probe));
  return view!;
}

describe("useTranscriptView", () => {
  it("offers no Stop while the bot only waits on the user's answer", () => {
    expect(viewWithRun("waiting_input").composerRunning).toBe(false);
  });
});
