import type { MessageBlock } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import type { Evidence } from "./cases.js";
import { narrationBetweenTools, VERBOSITY_EVAL_CASES, visibleWords } from "./verbosity.js";

const steps: MessageBlock = { kind: "steps", steps: [{ label: "Crm list records", count: 1 }] };

function evidence(text: string, blocks: MessageBlock[]): Evidence {
  return {
    text,
    turnMessages: [[{ blocks, beforeTools: false }]],
    files: {},
    records: [],
    notes: [],
    calls: [{ tool: "CRM_LIST_RECORDS", args: {}, outcome: "read" }],
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

  it("finds visible text between tool calls, allowing one opening line", () => {
    expect(
      narrationBetweenTools([
        {
          beforeTools: false,
          blocks: [
            { kind: "text", text: "Let me check the CRM." },
            steps,
            { kind: "text", text: "That failed, retrying." },
            steps,
            { kind: "text", text: "Answer." },
          ],
        },
      ]),
    ).toEqual(["That failed, retrying."]);
  });

  it("counts narration posted as its own message before the final one", () => {
    expect(
      narrationBetweenTools([
        { beforeTools: false, blocks: [{ kind: "text", text: "Still checking the CRM." }] },
        { beforeTools: false, blocks: [steps, steps, { kind: "text", text: "Answer." }] },
      ]),
    ).toEqual(["Still checking the CRM."]);
  });

  it("allows an opener posted as its own message before the first tool call", () => {
    expect(
      narrationBetweenTools([
        { beforeTools: true, blocks: [{ kind: "text", text: "Checking the CRM." }] },
        { beforeTools: false, blocks: [steps, { kind: "text", text: "Answer." }] },
      ]),
    ).toEqual([]);
  });

  it("passes a direct answer after tool work", () => {
    const answer = "Example Bakery is a lead with normal priority.";
    expect(failed(evidence(answer, [steps, { kind: "text", text: answer }]))).toEqual([]);
  });

  it("fails narration between tool calls even when the answer is short", () => {
    const blocks: MessageBlock[] = [
      steps,
      { kind: "text", text: "Retrying." },
      steps,
      { kind: "text", text: "Lead, normal." },
    ];
    expect(failed(evidence("Retrying.\nLead, normal.", blocks))).toEqual([
      "no-narration-between-tool-calls",
    ]);
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
