import { describe, expect, it } from "vitest";
import type { Evidence } from "./cases.js";
import { EMPTY_SETTINGS } from "./cases.js";
import {
  RECALL_EVAL_CASES,
  RECALL_FIXTURE_VERSION,
  RECALL_JUDGE_CALIBRATION,
  RECALL_JUDGE_VERSION,
} from "./recall.js";

const scenario = (id: string) => RECALL_EVAL_CASES.find((c) => c.id === `recall-${id}`)!;
const LEASE_PATH = "attachments/abc123.md";
const onComputer = { "lisbon-office-lease.md": { path: LEASE_PATH, content: "Notice period" } };
function evidence(
  toolCalls: Evidence["toolCalls"],
  text = "",
  seededAttachments: Evidence["seededAttachments"] = onComputer,
): Evidence {
  return {
    text,
    files: {},
    seededAttachments,
    records: [],
    notes: [],
    calls: [],
    routines: [],
    memory: "",
    approvalPending: false,
    pendingApproval: null,
    priorMemory: "",
    toolNames: toolCalls.map((c) => c.name),
    toolCalls,
    finalStep: 1,
    settings: EMPTY_SETTINGS,
    settingsBefore: EMPTY_SETTINGS,
    messaging: { originThreadId: null, outbound: [] },
  };
}
const failed = (id: string, e: Evidence) =>
  scenario(id)
    .grade(e)
    .filter((c) => !c.pass)
    .map((c) => c.id);
const search = { step: 1, name: "search_history", args: { query: "lease" } };
const read = { step: 1, name: "read_file", args: { path: "attachments/abc123.md" } };

describe("recall outcome grading", () => {
  it("seeds the file far outside the recent window, with or without a caption", () => {
    for (const id of ["old-file-captioned", "old-file-uncaptioned", "absent-file"]) {
      const history = scenario(id).history!;
      expect(history.version).toBe(RECALL_FIXTURE_VERSION);
      expect(history.messages).toHaveLength(1000);
      const shared = history.messages.filter((m) => m.file);
      expect(shared.map((m) => [m.seq, m.role, m.file!.name])).toEqual([
        [30, "user", "lisbon-office-lease.md"],
      ]);
      expect(history.summary!.text).not.toContain("90");
    }
    expect(scenario("old-file-uncaptioned").history!.messages[30]!.text).toBe("");
  });

  it("requires looking back and reading the earlier file before the answer counts", () => {
    expect(failed("old-file-captioned", evidence([search, read]))).toEqual([]);
    expect(failed("old-file-uncaptioned", evidence([search]))).toEqual(["read-earlier-file"]);
    expect(failed("old-file-captioned", evidence([]))).toEqual([
      "searched-history",
      "read-earlier-file",
    ]);
    // Work from an earlier step does not count for the question being graded.
    expect(failed("old-file-captioned", evidence([{ ...read, step: 0 }, search]))).toEqual([
      "read-earlier-file",
    ]);
    expect(
      failed(
        "old-file-captioned",
        evidence([search, { ...read, args: { path: `./${LEASE_PATH}` } }]),
      ),
    ).toEqual([]);
    // Another file, another tool, or a lease that never reached the computer does not count.
    expect(
      failed(
        "old-file-captioned",
        evidence([search, { ...read, args: { path: "attachments/other.md" } }]),
      ),
    ).toEqual(["read-earlier-file"]);
    expect(
      failed("old-file-captioned", evidence([search, { ...read, name: "list_files" }])),
    ).toEqual(["read-earlier-file"]);
    const missing = { "lisbon-office-lease.md": { path: LEASE_PATH, content: null } };
    expect(failed("old-file-captioned", evidence([search, read], "", missing))).toEqual([
      "read-earlier-file",
    ]);
  });

  it("asks only that a never-shared file was looked for", () => {
    expect(failed("absent-file", evidence([search]))).toEqual([]);
    expect(failed("absent-file", evidence([]))).toEqual(["searched-history"]);
  });

  it("seeds one earlier reply that worked with tools, compacted only in the long chat", () => {
    for (const [id, size] of [
      ["tool-steps-replayed", 24],
      ["tool-steps-compacted", 100],
    ] as const) {
      for (const variant of [id, `${id}-absent`]) {
        const history = scenario(variant).history!;
        expect(history.messages).toHaveLength(size);
        expect(history.messages.filter((m) => m.steps).map((m) => [m.seq, m.role])).toEqual([
          [3, "bot"],
        ]);
        expect(history.compact).toBe(size === 100 ? true : undefined);
        expect(history.summary).toBeUndefined();
      }
    }
    const notes = (id: string) =>
      scenario(id)
        .history!.messages[3]!.steps!.map((step) => step.note ?? "")
        .join(" ");
    expect(notes("tool-steps-replayed")).toContain("Midnight Lizard");
    expect(notes("tool-steps-replayed-absent")).not.toMatch(/extension/i);
  });

  it("fails a reply that copies the replayed step list", () => {
    expect(failed("tool-steps-replayed", evidence([], "Yes, Midnight Lizard."))).toEqual([]);
    expect(
      failed("tool-steps-replayed", evidence([], "[tool calls this reply made]\n- Shell ×2")),
    ).toEqual(["no-step-log"]);
  });

  it("fails a history lookup on everyday turns only when the turn cannot need one", () => {
    const egg = scenario("ordinary-visible").history!.messages.slice(-2);
    expect(egg.map((m) => [m.role, m.text])).toEqual([
      ["user", "How long should I boil an egg for a jammy yolk?"],
      ["bot", "About six and a half minutes, then into cold water."],
    ]);
    for (const id of ["sign-off", "visible", "general", "related"]) {
      const history = scenario(`ordinary-${id}`).history!;
      expect(history.messages[3]!.steps?.[0]?.note).toContain("Midnight Lizard");
      expect(failed(`ordinary-${id}`, evidence([], "reply"))).toEqual([]);
      expect(failed(`ordinary-${id}`, evidence([search], "reply"))).toEqual(
        id === "related" ? [] : ["no-history-lookup"],
      );
    }
  });

  it("leaves meaning to a versioned judge with labelled anchors for every rubric", () => {
    for (const c of RECALL_EVAL_CASES) {
      const input = c.judge?.(evidence([], "reply"));
      expect(input?.rubric.startsWith(`${RECALL_JUDGE_VERSION}:`)).toBe(true);
      expect(input?.evidence).toEqual({ reply: "reply" });
      const anchors = RECALL_JUDGE_CALIBRATION.filter((a) => a.input.rubric === input?.rubric);
      expect(new Set(anchors.map((a) => a.pass))).toEqual(new Set([true, false]));
    }
  });
});
