import { describe, expect, it } from "vitest";
import {
  answerableAskMessageIds,
  resolveAskChoice,
  selectedAskActionLabel,
} from "./answerable-ask.js";

describe("answerableAskMessageIds", () => {
  it("finds a waiting prompt even when a newer group run is active", () => {
    expect(
      answerableAskMessageIds({
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
    ).toEqual(new Set(["ask-1"]));
  });

  it("keeps every pending card answerable after newer work and messages", () => {
    expect(
      answerableAskMessageIds({
        activeRuns: [
          { id: "paused-a", status: "waiting_input" },
          { id: "paused-b", status: "waiting_input" },
          { id: "new", status: "running" },
        ],
        messages: [
          { id: "question", runId: "paused-a", blocks: [{ kind: "ask", status: "pending" }] },
          { id: "approval", runId: "paused-b", blocks: [{ kind: "ask", status: "pending" }] },
          { id: "done", runId: "paused-a", blocks: [{ kind: "ask", status: "answered" }] },
          { id: "new-message", runId: "new", blocks: [{ kind: "text" }] },
        ],
      }),
    ).toEqual(new Set(["question", "approval"]));
  });

  it("ignores answered prompts and prompts from non-waiting runs", () => {
    expect(
      answerableAskMessageIds({
        run: { id: "run-1", status: "running" },
        messages: [{ id: "ask-1", runId: "run-1", blocks: [{ kind: "ask", status: "pending" }] }],
      }),
    ).toEqual(new Set());
    expect(
      answerableAskMessageIds({
        run: { id: "run-1", status: "waiting_input" },
        messages: [{ id: "ask-1", runId: "run-1", blocks: [{ kind: "ask", status: "answered" }] }],
      }),
    ).toEqual(new Set());
  });
});

describe("selectedAskActionLabel", () => {
  it("maps a choice answer id to its user-facing label", () => {
    expect(
      selectedAskActionLabel("choice-2", [
        { id: "choice-1", label: "Berlin" },
        { id: "choice-2", label: "Seoul" },
      ]),
    ).toBe("Seoul");
  });

  it("falls back to the answer when an action is unavailable", () => {
    expect(selectedAskActionLabel("custom", undefined)).toBe("custom");
  });
});

describe("resolveAskChoice", () => {
  const actions = [
    { id: "choice-1", label: "Berlin" },
    { id: "choice-2", label: "Seoul" },
  ];

  it("matches an offered choice by id or label", () => {
    expect(resolveAskChoice("choice-2", actions)).toEqual({ id: "choice-2", label: "Seoul" });
    expect(resolveAskChoice(" seoul ", actions)).toEqual({ id: "choice-2", label: "Seoul" });
  });

  it("leaves unmatched free-text as a custom answer", () => {
    expect(resolveAskChoice("Toronto", actions)).toBeUndefined();
  });
});
