import { describe, expect, it } from "vitest";
import { latestAnswerableAskMessageId } from "./answerable-ask.js";

describe("latestAnswerableAskMessageId", () => {
  it("finds a waiting prompt even when a newer group run is active", () => {
    expect(
      latestAnswerableAskMessageId({
        run: { id: "run-newer", status: "running" },
        activeRuns: [
          { id: "run-newer", status: "running" },
          { id: "run-waiting", status: "waiting_input" },
        ],
        messages: [
          {
            id: "ask-1",
            runId: "run-waiting",
            blocks: [{ kind: "ask", status: "pending" }],
          },
        ],
      }),
    ).toBe("ask-1");
  });

  it("ignores answered prompts and prompts from non-waiting runs", () => {
    expect(
      latestAnswerableAskMessageId({
        run: { id: "run-1", status: "running" },
        messages: [{ id: "ask-1", runId: "run-1", blocks: [{ kind: "ask", status: "pending" }] }],
      }),
    ).toBeNull();
    expect(
      latestAnswerableAskMessageId({
        run: { id: "run-1", status: "waiting_input" },
        messages: [{ id: "ask-1", runId: "run-1", blocks: [{ kind: "ask", status: "answered" }] }],
      }),
    ).toBeNull();
  });
});
