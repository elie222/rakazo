import { describe, expect, it } from "vitest";
import {
  answerableAskMessageIds,
  askAsPlainText,
  dismissableAskMessageIds,
  isTextAnswerableAsk,
  plainTextAskAnswer,
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

describe("dismissableAskMessageIds", () => {
  it.each(["run", "activeRuns"])("uses each message's run from %s", (source) => {
    const run = { id: "run-1", status: "waiting_input", userId: "owner" };
    const snapshot = {
      ...(source === "run"
        ? { run }
        : { activeRuns: [run, { ...run, id: "run-2", userId: "other" }] }),
      messages: [
        {
          id: "secret",
          runId: "run-1",
          blocks: [{ kind: "ask", input: "secret", status: "pending" }],
        },
        {
          id: "login",
          runId: "run-1",
          blocks: [
            {
              kind: "ask",
              input: "secret",
              status: "pending",
              credential: { auth: { type: "login" } },
            },
          ],
        },
        {
          id: "other",
          runId: "run-2",
          blocks: [{ kind: "ask", input: "secret", status: "pending" }],
        },
        {
          id: "answered",
          runId: "run-1",
          blocks: [{ kind: "ask", input: "secret", status: "answered" }],
        },
        { id: "question", runId: "run-1", blocks: [{ kind: "ask", status: "pending" }] },
        {
          id: "approval",
          runId: "run-1",
          blocks: [{ kind: "ask", input: "secret", approvalEffectId: "effect", status: "pending" }],
        },
      ],
    };
    expect(dismissableAskMessageIds(snapshot, "owner")).toEqual(new Set(["secret", "login"]));
    expect(dismissableAskMessageIds(snapshot, "member")).toEqual(new Set());
    expect(dismissableAskMessageIds(snapshot)).toEqual(new Set());
    expect(
      dismissableAskMessageIds(
        { ...snapshot, run: { ...run, userId: undefined }, activeRuns: undefined },
        "owner",
      ),
    ).toEqual(new Set());
    expect(
      dismissableAskMessageIds(
        { ...snapshot, run: { ...run, status: "running" }, activeRuns: undefined },
        "owner",
      ),
    ).toEqual(new Set());
    expect(dismissableAskMessageIds(null, "owner")).toEqual(new Set());
    expect(answerableAskMessageIds(snapshot).has("secret")).toBe(true);
  });
});

describe("plain-text questions", () => {
  const actions = [
    { id: "choice-1", label: "Berlin" },
    { id: "choice-2", label: "Paris" },
  ];

  it("lists the options by number after the question and its detail", () => {
    expect(askAsPlainText({ text: "Which city?", detail: "For the trip in May.", actions })).toBe(
      "Which city?\n\nFor the trip in May.\n\n1. Berlin\n2. Paris",
    );
    expect(askAsPlainText({ text: "What should I call it?" })).toBe("What should I call it?");
  });

  it("answers with the option a bare number picks, and otherwise with the reply", () => {
    expect(plainTextAskAnswer(" 2 ", actions)).toBe("choice-2");
    expect(plainTextAskAnswer("paris", actions)).toBe("paris");
    expect(plainTextAskAnswer("3", actions)).toBe("3");
    expect(plainTextAskAnswer("2 please", actions)).toBe("2 please");
    for (const reply of ["2.", "2)", "#2", "2、", " # 2 "])
      expect(plainTextAskAnswer(reply, actions)).toBe("choice-2");
    expect(plainTextAskAnswer("3.", actions)).toBe("3.");
    expect(plainTextAskAnswer("2", undefined)).toBe("2");
  });

  it("reads a listed number as its position, even when labels are numbers", () => {
    const counts = [
      { id: "choice-1", label: "2" },
      { id: "choice-2", label: "5" },
      { id: "choice-3", label: "10" },
    ];
    expect(plainTextAskAnswer("2", counts)).toBe("choice-2");
    expect(plainTextAskAnswer("3", counts)).toBe("choice-3");
    // Past the list, the reply is passed on for the usual label match.
    expect(plainTextAskAnswer("5", counts.slice(0, 2))).toBe("5");
  });

  it("takes other numbered forms as the reply's own words", () => {
    for (const reply of ["２", "-1", "0", "2..", "2.5", "(2"]) {
      expect(plainTextAskAnswer(reply, actions)).toBe(reply);
    }
  });

  it("leaves approvals and secret requests to their cards", () => {
    expect(isTextAnswerableAsk({ kind: "ask", actions })).toBe(true);
    expect(isTextAnswerableAsk({ kind: "ask", input: "secret" })).toBe(false);
    expect(
      isTextAnswerableAsk({
        kind: "ask",
        approvalEffectId: "effect-1",
        actions: [
          { id: "allow", label: "Allow" },
          { id: "deny", label: "Deny" },
        ],
      }),
    ).toBe(false);
  });
});
