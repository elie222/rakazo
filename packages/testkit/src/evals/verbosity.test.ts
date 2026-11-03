import type { MessageBlock } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import type { Evidence } from "./cases.js";
import { EMPTY_SETTINGS } from "./cases.js";
import { VERBOSITY_EVAL_CASES, visibleTurn, visibleWords } from "./verbosity.js";

const steps: MessageBlock = { kind: "steps", steps: [{ label: "Crm list records", count: 1 }] };

function evidence(text: string, blocks: MessageBlock[]): Evidence {
  return {
    text,
    turnMessages: [[{ blocks, beforeTools: false }]],
    files: {},
    records: [],
    notes: [],
    calls: [{ tool: "CRM_LIST_RECORDS", args: {}, outcome: "read" }],
    toolCalls: [],
    finalStep: 1,
    settings: EMPTY_SETTINGS,
    settingsBefore: EMPTY_SETTINGS,
    routines: [],
    memory: "",
    approvalPending: false,
    pendingApproval: null,
    priorMemory: "",
    toolNames: [],
    messaging: { originThreadId: null, outbound: [] },
  };
}
const lookup = VERBOSITY_EVAL_CASES.find((c) => c.id === "verbosity-crm-lookup")!;
const failed = (e: Evidence) => lookup.grade(e).flatMap((c) => (c.pass ? [] : [c.id]));

describe("verbosity grading", () => {
  it("counts every visible word", () => expect(visibleWords(" one\ntwo  three ")).toBe(3));

  it("shows the judge every message of the turn, without tool steps", () => {
    expect(
      visibleTurn([
        { beforeTools: true, blocks: [{ kind: "text", text: "Checking the CRM." }] },
        { beforeTools: false, blocks: [steps, { kind: "text", text: "Answer." }] },
      ]),
    ).toBe("Checking the CRM.\n\nAnswer.");
  });

  it("passes a direct answer after tool work", () => {
    const answer = "Example Bakery is a lead with normal priority.";
    expect(failed(evidence(answer, [steps, { kind: "text", text: answer }]))).toEqual([]);
  });

  it("counts words posted mid-turn toward the budget", () => {
    const e = evidence("Lead, normal.", [steps, { kind: "text", text: "Lead, normal." }]);
    e.turnMessages = [
      [
        { beforeTools: false, blocks: [{ kind: "text", text: "word ".repeat(40).trim() }] },
        { beforeTools: false, blocks: [steps, { kind: "text", text: "Lead, normal." }] },
      ],
    ];
    expect(failed(e)).toEqual(["at-most-35-words"]);
  });

  it("gives the judge the owner's instructions", () => {
    const brief = VERBOSITY_EVAL_CASES.find((c) => c.id === "verbosity-owner-asked-brief")!;
    const input = brief.judge!(evidence("Done.", [steps, { kind: "text", text: "Done." }]));
    expect(input.evidence).toMatchObject({ ownerInstructions: brief.botSetup?.instructions });
  });

  it("fails a reply over the word budget", () => {
    const long = "word ".repeat(36).trim();
    expect(failed(evidence(long, [steps, { kind: "text", text: long }]))).toEqual([
      "at-most-35-words",
    ]);
  });

  it("gives every case a judge so short-but-wrong replies cannot pass", () => {
    for (const c of VERBOSITY_EVAL_CASES) expect(c.judge).toBeDefined();
  });
});
