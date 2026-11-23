import { describe, expect, it } from "vitest";
import type { Evidence } from "./cases.js";
import { EMPTY_SETTINGS } from "./cases.js";
import {
  ROUTINE_MODE_EVAL_CASES,
  ROUTINE_MODE_JUDGE_CALIBRATION,
  ROUTINE_MODE_JUDGE_VERSION,
} from "./routine-mode.js";

function evidence(routines: Evidence["routines"], routinesCreated = routines.length): Evidence {
  return {
    text: "",
    files: {},
    records: [],
    notes: [],
    calls: [],
    routines,
    routinesCreated,
    memory: "",
    approvalPending: false,
    pendingApproval: null,
    priorMemory: "",
    toolNames: [],
    toolCalls: [],
    finalStep: 1,
    settings: EMPTY_SETTINGS,
    settingsBefore: EMPTY_SETTINGS,
    messaging: { originThreadId: null, outbound: [] },
  };
}

const routine = (inChat: boolean) => ({
  name: "Routine",
  prompt: "Do the work.",
  crons: ["0 9 * * *"],
  active: true,
  inChat,
});
const byId = (id: string) => ROUTINE_MODE_EVAL_CASES.find((c) => c.id === id)!;
const passes = (id: string, e: Evidence) =>
  byId(id)
    .grade(e)
    .every((c) => c.pass);

describe("routine mode eval", () => {
  it("passes a report only when it runs alongside the chat", () => {
    expect(passes("routine-mode-weather", evidence([routine(false)]))).toBe(true);
    expect(passes("routine-mode-weather", evidence([routine(true)]))).toBe(false);
  });

  it("passes a follow-up on the chat's work only when it runs in the chat", () => {
    expect(passes("routine-mode-plan-update", evidence([routine(true)]))).toBe(true);
    expect(passes("routine-mode-plan-update", evidence([routine(false)]))).toBe(false);
  });

  it("fails without exactly one routine", () => {
    expect(passes("routine-mode-reminder", evidence([]))).toBe(false);
    expect(passes("routine-mode-reminder", evidence([routine(false)], 2))).toBe(false);
  });

  it("asks the judge about the created prompt only where the chat is left behind", () => {
    const input = byId("routine-mode-job-alert").judge?.(evidence([routine(false)]));
    expect(input?.rubric).toContain(ROUTINE_MODE_JUDGE_VERSION);
    expect(byId("routine-mode-draft-revision").judge).toBeUndefined();
  });

  it("has both passing and failing calibration anchors", () => {
    expect(ROUTINE_MODE_JUDGE_CALIBRATION.some((anchor) => anchor.pass)).toBe(true);
    expect(ROUTINE_MODE_JUDGE_CALIBRATION.some((anchor) => !anchor.pass)).toBe(true);
  });
});
