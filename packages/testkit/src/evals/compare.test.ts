import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import type { TrialResult } from "./report.js";

function trial(caseId: string, strategy: string, trial: number, status: TrialResult["status"]) {
  return { caseId, strategy, trial, status };
}

const baseline = {
  version: 2,
  kind: "real-model-product-eval",
  suite: "history",
  startedAt: "2026-10-01T00:00:00.000Z",
  model: "synthetic-model",
  provider: "synthetic-provider",
  modelLimits: { contextWindow: null, maxOutputTokens: null },
  controls: { trials: 2, timeoutMs: 60_000, maxToolCalls: 30 },
  strategy: "comparison",
  strategies: ["current", "retrieval"],
  executionOrder: "Rotate strategy order deterministically",
  promptOrder: "Stable guidance before changing context",
  historyPreparation: null,
  assistedRetries: false,
  fixtureVersion: "fixture-v1",
  caseFixtureVersions: { recall: "fixture-v1", pagination: "fixture-v1" },
  codeRevision: "synthetic-before",
  workingDiffHash: null,
  pricing: { source: "synthetic", version: "1", input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
  judge: null,
  spendCapUsd: 5,
  workflowTotals: { modelCalls: 7, costUsd: 0 },
  trials: [
    trial("recall", "current", 1, "passed"),
    trial("recall", "retrieval", 1, "passed"),
    trial("recall", "retrieval", 2, "passed"),
    trial("recall", "current", 2, "passed"),
    trial("pagination", "retrieval", 1, "failed"),
    trial("pagination", "current", 1, "passed"),
    trial("pagination", "current", 2, "passed"),
    trial("pagination", "retrieval", 2, "not-run"),
  ],
};

const candidate = {
  ...baseline,
  replyMode: "chat",
  startedAt: "2026-10-02T00:00:00.000Z",
  codeRevision: "synthetic-after",
  workflowTotals: { modelCalls: 7, costUsd: null },
  trials: [
    trial("pagination", "retrieval", 2, "failed"),
    trial("pagination", "current", 2, "not-run"),
    trial("pagination", "current", 1, "passed"),
    trial("pagination", "retrieval", 1, "failed"),
    trial("recall", "current", 2, "passed"),
    {
      ...trial("recall", "retrieval", 2, "failed"),
      origin: { kind: "regraded", fingerprint: "synthetic", startedAt: baseline.startedAt },
    },
    trial("recall", "retrieval", 1, "passed"),
    trial("recall", "current", 1, "passed"),
  ],
};

function compareReports(after: object = candidate, before: object = baseline) {
  const dir = mkdtempSync(path.join(tmpdir(), "eval-compare-"));
  try {
    const beforePath = path.join(dir, "before.json");
    const afterPath = path.join(dir, "after.json");
    writeFileSync(beforePath, JSON.stringify(before));
    writeFileSync(afterPath, JSON.stringify(after));
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        import.meta.resolve("tsx"),
        path.resolve(import.meta.dirname, "compare.ts"),
        beforePath,
        afterPath,
      ],
      { encoding: "utf8", timeout: 20_000 },
    );
    if (result.error) throw result.error;
    return result;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

it("matches reordered trials by case, strategy and trial number and preserves unknown cost", () => {
  const { stdout, stderr, status } = compareReports();
  expect(status, stderr).toBe(0);
  expect(stdout.trim().split(/\r?\n/)).toEqual([
    "Regressions (passed -> failed):",
    "- recall (strategy: retrieval, trial: 2) [candidate regraded]",
    "Not run in candidate:",
    "- pagination (strategy: current, trial: 2)",
    "Not run in baseline:",
    "- pagination (strategy: retrieval, trial: 2)",
    "Workflow cost (USD): 0 -> unknown",
  ]);
});

it.each([
  {
    field: "controls.timeoutMs",
    change: { controls: { ...candidate.controls, timeoutMs: 10_000 } },
  },
  { field: "fixtureVersion", change: { fixtureVersion: "fixture-v2" } },
  { field: "suite", change: { suite: "product" } },
  { field: "replyMode", change: { replyMode: "messages" } },
  {
    field: "modelLimits",
    change: { modelLimits: { ...candidate.modelLimits, maxOutputTokens: 4_096 } },
  },
  { field: "cacheCapabilities", change: { cacheCapabilities: { scope: "connection" } } },
  { field: "promptOrder", change: { promptOrder: "Stable guidance after changing context" } },
  {
    field: "caseFixtureVersions",
    change: { caseFixtureVersions: { ...candidate.caseFixtureVersions, recall: "fixture-v2" } },
  },
  { field: "planned trials", change: { trials: candidate.trials.slice(1) } },
])("rejects a comparison when $field differs", ({ field, change }) => {
  const { stdout, stderr, status } = compareReports({ ...candidate, ...change });
  expect(status).not.toBe(0);
  expect(stdout).toBe("");
  expect(stderr).toContain("Reports cannot be directly compared");
  expect(stderr).toContain(field);
});

it("rejects a comparison when only one report records the suite", () => {
  const { stdout, stderr, status } = compareReports({ ...candidate, suite: undefined });
  expect(status).toBe(1);
  expect(stdout).toBe("");
  expect(stderr).toContain("Reports cannot be directly compared. Differences: suite.");
});

it("reports missing workflow cost as unknown", () => {
  const { stdout, stderr, status } = compareReports({ ...candidate, workflowTotals: undefined });
  expect(status, stderr).toBe(0);
  expect(stdout).toContain("Workflow cost (USD): 0 -> unknown");
});

it("rejects a comparison when the recorded judge rubric differs", () => {
  const judge = {
    model: "synthetic-judge",
    provider: baseline.provider,
    rubricVersion: "rubric-v1",
    pricing: baseline.pricing,
  };
  const { stdout, stderr, status } = compareReports(
    { ...candidate, judge: { ...judge, rubricVersion: "rubric-v2" } },
    { ...baseline, judge },
  );
  expect(status).toBe(1);
  expect(stdout).toBe("");
  expect(stderr).toContain("Reports cannot be directly compared. Differences: judge.");
});

const judge = {
  model: "synthetic-judge",
  provider: baseline.provider,
  rubricVersion: "rubric-v1",
  pricing: baseline.pricing,
  settings: {
    endpoint: "0123456789ab",
    maxOutputTokens: 2048,
    reasoning: null,
    thinkingLevel: null,
  },
};

it.each([
  { field: "judge.endpoint", settings: { endpoint: null } },
  { field: "judge.maxOutputTokens", settings: { maxOutputTokens: 4096 } },
  { field: "judge.thinkingLevel", settings: { thinkingLevel: "high" } },
])("rejects a comparison when $field differs", ({ field, settings }) => {
  const { stdout, stderr, status } = compareReports(
    { ...candidate, judge: { ...judge, settings: { ...judge.settings, ...settings } } },
    { ...baseline, judge },
  );
  expect(status).toBe(1);
  expect(stdout).toBe("");
  expect(stderr).toContain(`Reports cannot be directly compared. Differences: ${field}.`);
});

it("compares reports with the same judge settings without a note", () => {
  const { stdout, stderr, status } = compareReports(
    { ...candidate, judge },
    { ...baseline, judge },
  );
  expect(status, stderr).toBe(0);
  expect(stdout).not.toContain("unknown in");
});

it("names the report whose judge settings were not recorded", () => {
  const { settings: _, ...legacyJudge } = judge;
  const { stdout, stderr, status } = compareReports(
    { ...candidate, judge },
    { ...baseline, judge: legacyJudge },
  );
  expect(status, stderr).toBe(0);
  expect(stdout).toContain(
    "Judge endpoint, output limit and reasoning settings: unknown in baseline",
  );
});

it("compares legacy reports that both omit suite", () => {
  const { stdout, stderr, status } = compareReports(
    { ...candidate, suite: undefined },
    { ...baseline, suite: undefined },
  );
  expect(status, stderr).toBe(0);
  expect(stdout).toContain("Regressions (passed -> failed):");
});
