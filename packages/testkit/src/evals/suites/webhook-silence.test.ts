import { describe, expect, it } from "vitest";
import type { Evidence } from "../cases.js";
import { EMPTY_SETTINGS } from "../cases.js";
import type { RoutineEvidence } from "./silence.js";
import { WEBHOOK_SILENCE_EVAL_CASES } from "./webhook-silence.js";

const run = (text: string, unread: boolean): RoutineEvidence => ({
  text,
  unread,
  messages: text ? [[{ kind: "text", text }]] : [],
  progress: [],
  notifications: unread
    ? [{ kind: "completion", title: "Bot", body: text, botId: "bot", threadId: "thread" }]
    : [],
  calls: [],
  observedCompletion: true,
});
const evidence = (...routineRuns: RoutineEvidence[]): Evidence => ({
  text: routineRuns.at(-1)?.text ?? "",
  files: {},
  records: [],
  notes: [],
  calls: [],
  routines: [],
  memory: "",
  approvalPending: false,
  pendingApproval: null,
  priorMemory: "",
  toolNames: [],
  toolCalls: [],
  finalStep: routineRuns.length,
  settings: EMPTY_SETTINGS,
  settingsBefore: EMPTY_SETTINGS,
  messaging: { originThreadId: null, outbound: [] },
  routineRuns,
});
const failureThenPass = WEBHOOK_SILENCE_EVAL_CASES.find(
  (c) => c.id === "webhook-silence-failure-then-pass",
)!;
const passes = (e: Evidence) => failureThenPass.grade(e).every((c) => c.pass);

describe("webhook silence grading", () => {
  it("accepts a reported failure followed by a silent pass", () => {
    expect(passes(evidence(run("Lint failed on release/2.3.", true), run("", false)))).toBe(true);
  });
  it("rejects a note posted for a passing delivery", () => {
    expect(
      passes(
        evidence(run("Lint failed on release/2.3.", true), run("No response. Try again.", true)),
      ),
    ).toBe(false);
  });
  it("rejects a reported failure that sent no push", () => {
    const reported = { ...run("Lint failed on release/2.3.", true), notifications: [] };
    expect(passes(evidence(reported, run("", false)))).toBe(false);
  });
  it("rejects a failure that was never reported", () => {
    expect(passes(evidence(run("", false), run("", false)))).toBe(false);
  });
});
