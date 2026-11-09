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

  it("keeps the short chat's variants and varies the long chat's small talk", () => {
    const steps = (id: string) => scenario(id).history!.messages[3]!.steps!;
    expect(steps("tool-steps-replayed").every((step) => step.outcomes)).toBe(true);
    expect(steps("tool-steps-replayed-intent").some((step) => step.outcomes)).toBe(false);
    expect(steps("tool-steps-replayed-intent").map((step) => step.note)).toEqual(
      steps("tool-steps-replayed").map((step) => step.note),
    );
    // The paraphrased earlier turn shares no distinctive word with the question.
    const earlier = scenario("tool-steps-replayed-paraphrased")
      .history!.messages.slice(2, 4)
      .map((m) => `${m.text} ${(m.steps ?? []).map((step) => step.note ?? "").join(" ")}`)
      .join(" ");
    expect(earlier).toContain("Midnight Lizard");
    expect(earlier).not.toMatch(/install|extension|browser/i);
    const long = scenario("tool-steps-compacted").history!.messages.map((m) => m.text);
    const chat = long.filter(Boolean);
    expect(new Set(chat).size).toBe(chat.length);
  });

  it("records re-checks, lookups and judged behaviour without failing on them", () => {
    const shell = { step: 1, name: "shell", args: {} };
    for (const c of RECALL_EVAL_CASES.filter((c) => /tool-steps|ordinary/.test(c.id))) {
      expect(c.shellUnneeded).toBe(true);
      const observed = c.observe!(evidence([search, shell], "reply"));
      expect(observed.reverified).toBe(true);
      expect(observed["looked-back"]).toBe(true);
      expect(c.observe!(evidence([{ ...shell, step: 0 }], "reply")).reverified).toBe(false);
      const judged = Object.values(observed).filter((v) => typeof v === "object");
      expect(judged.length).toBeGreaterThan(0);
      for (const input of judged) {
        expect(input.rubric.startsWith(`${RECALL_JUDGE_VERSION} behaviour:`)).toBe(true);
        const anchors = RECALL_JUDGE_CALIBRATION.filter((a) => a.input.rubric === input.rubric);
        expect(new Set(anchors.map((a) => a.pass))).toEqual(new Set([true, false]));
      }
    }
    expect(Object.keys(scenario("ordinary-sign-off").observe!(evidence([], "")))).toContain(
      "unprompted-doubt",
    );
    expect(Object.keys(scenario("tool-steps-replayed").observe!(evidence([], "")))).not.toContain(
      "unprompted-doubt",
    );
  });

  it("gives re-checks a computer that matches what the earlier reply did", () => {
    const computer = (id: string) => scenario(id).computer!;
    for (const id of ["tool-steps-replayed", "tool-steps-compacted", "ordinary-sign-off"]) {
      expect(computer(id).screen.dark).toBe(true);
      expect(computer(id).shell[0]!.output).toContain("Midnight Lizard");
    }
    expect(computer("tool-steps-replayed-absent").screen.dark).toBe(false);
    expect(computer("tool-steps-replayed-absent").shell[0]!.output).not.toContain("Midnight");
    // The chat happened earlier today, so it reads as the one under way.
    const seeded = scenario("tool-steps-replayed").history!.messages;
    expect(Date.now() - seeded[0]!.createdAt.getTime()).toBeLessThan(24 * 60 * 60_000);
    expect(seeded.at(-1)!.createdAt.getTime()).toBeLessThan(Date.now());
  });

  it("observes, rather than grades, a reply that copies the replayed marker", () => {
    const copied = evidence([], "[tool calls this reply made]\n- Shell ×2");
    expect(failed("tool-steps-replayed", copied)).toEqual([]);
    expect(scenario("tool-steps-replayed").observe!(copied)["copied-marker"]).toBe(true);
    expect(
      scenario("tool-steps-replayed").observe!(evidence([], "Yes, Midnight Lizard."))[
        "copied-marker"
      ],
    ).toBe(false);
  });

  it("fails a history lookup on everyday turns only when the turn cannot need one", () => {
    const egg = scenario("ordinary-visible").history!.messages.slice(-2);
    expect(egg.map((m) => [m.role, m.text])).toEqual([
      ["user", "How long should I boil an egg for a jammy yolk?"],
      ["bot", "About six and a half minutes, then into cold water."],
    ]);
    for (const id of ["sign-off", "visible", "general", "related", "never-told"]) {
      const history = scenario(`ordinary-${id}`).history!;
      expect(history.messages[3]!.steps?.[0]?.note).toContain("Midnight Lizard");
      expect(failed(`ordinary-${id}`, evidence([], "reply"))).toEqual([]);
      expect(failed(`ordinary-${id}`, evidence([search], "reply"))).toEqual(
        id === "related" || id === "never-told" ? [] : ["no-history-lookup"],
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
