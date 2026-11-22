import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  checkBudgets,
  parsePerformanceReport,
  parseTcpPort,
  percentageDelta,
  renderBudgetTable,
  roundedSummary,
  roundMetric,
  summarize,
} from "./performance-report.js";

describe("performance report statistics", () => {
  it("summarizes a distribution without mutating it", () => {
    const values = [40, 10, 30, 20];

    expect(summarize(values)).toEqual({
      count: 4,
      min: 10,
      median: 25,
      p95: 38.5,
      max: 40,
    });
    expect(values).toEqual([40, 10, 30, 20]);
  });

  it("calculates comparable percentage deltas", () => {
    expect(percentageDelta(100, 75)).toBe(-25);
    expect(percentageDelta(0, 0)).toBe(0);
    expect(percentageDelta(0, 1)).toBeNull();
    expect(roundMetric(1.23456)).toBe(1.23);
  });

  it("rejects an empty distribution", () => {
    expect(() => summarize([])).toThrow("empty sample");
  });
});

describe("performance report input", () => {
  it("rejects missing and unknown report schemas with a useful source name", () => {
    expect(() => parsePerformanceReport({}, "before.json")).toThrow(
      "Invalid performance report before.json: unsupported schemaVersion undefined",
    );
    expect(() => parsePerformanceReport({ schemaVersion: 99 }, "after.json")).toThrow(
      "Invalid performance report after.json: unsupported schemaVersion 99",
    );
  });

  it("migrates schema 1 memory labels to working-set labels", () => {
    const distribution = { count: 1, min: 10, median: 10, p95: 10, max: 10 };
    const report = parsePerformanceReport(
      {
        schemaVersion: 1,
        label: "before",
        environment: {},
        summary: {
          cacheColdShellUsableMs: distribution,
          warmShellUsableMs: distribution,
          settingsPaintedMs: 10,
          settingsSettledMs: 10,
          typingKeyPaintMs: distribution,
          idleCpuPercent: distribution,
          idleSummedPrivateKiB: distribution,
          streamingCpuPercent: distribution,
        },
      },
      "legacy.json",
    );

    expect(report.schemaVersion).toBe(2);
    expect(report.summary.idleSummedWorkingSetKiB).toEqual(distribution);
    expect(report.summary.hiddenSummedWorkingSetKiB).toBeNull();
  });

  it("validates configured TCP ports", () => {
    expect(parseTcpPort("55400", "PERF_WEB_PORT")).toBe(55_400);
    for (const value of ["", "nope", "0", "65536", "1.5", "Infinity"]) {
      expect(() => parseTcpPort(value, "PERF_WEB_PORT")).toThrow(
        "PERF_WEB_PORT must be an integer between 1 and 65535",
      );
    }
  });
});

describe("performance comparison table", () => {
  it.each([
    ["baseline", "candidate", "baseline", "candidate"],
    ["before|cold", "after|warm", "before\\|cold", "after\\|warm"],
    ["before\nsecond", "after\r\nsecond\rthird", "before second", "after second third"],
    ["before\\|cold", "after\\", "before\\\\\\|cold", "after\\\\"],
    ["基线 🦞", "优化后", "基线 🦞", "优化后"],
  ])(
    "keeps labels %j and %j in separate header cells",
    (before, after, escapedBefore, escapedAfter) => {
      const directory = mkdtempSync(path.join(tmpdir(), "perf-compare-label-"));
      const distribution = { count: 1, min: 10, median: 10, p95: 10, max: 10 };
      const report = {
        schemaVersion: 2,
        environment: {},
        summary: {
          cacheColdShellUsableMs: distribution,
          warmShellUsableMs: distribution,
          settingsPaintedMs: 10,
          settingsSettledMs: 10,
          typingKeyPaintMs: distribution,
          idleCpuPercent: distribution,
          idleSummedWorkingSetKiB: distribution,
          streamingCpuPercent: distribution,
          reopenMs: null,
          hiddenSummedWorkingSetKiB: null,
        },
      };
      try {
        const beforePath = path.join(directory, "before.json");
        const afterPath = path.join(directory, "after.json");
        writeFileSync(beforePath, JSON.stringify({ ...report, label: before }));
        writeFileSync(afterPath, JSON.stringify({ ...report, label: after }));
        const output = execFileSync(
          process.execPath,
          [
            "--import",
            "tsx",
            fileURLToPath(new URL("./compare-performance.ts", import.meta.url)),
            beforePath,
            afterPath,
          ],
          { encoding: "utf8" },
        );
        const lines = output.trimEnd().split("\n");
        expect(lines).toHaveLength(10);
        expect(lines[0]).toBe(`| Metric | ${escapedBefore} | ${escapedAfter} | Delta |`);
        expect(lines[1]).toBe("| --- | ---: | ---: | ---: |");
        expect(lines[2]).toBe("| Cache-cold shell usable (median ms) | 10 | 10 | 0% |");
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );
});

describe("performance budgets", () => {
  const budgets = [
    { key: "switchMs", title: "Switch", unit: "ms", budget: 100 },
    { key: "typingMs", title: "Typing", unit: "ms", budget: 16 },
    { key: "idlePercent", title: "Idle", unit: "%", budget: 2 },
  ];

  it.each([
    { samples: [16, 16.01, 16.04], median: 16.01, p95: 16.04, over: true },
    { samples: [15.98, 16, 16.04], median: 16, p95: 16.04, over: false },
    { samples: [15.98, 15.99, 16.02], median: 15.99, p95: 16.02, over: false },
  ])(
    "shows a $median ms median and its p95 without changing the budget result",
    ({ samples, median, p95, over }) => {
      const rows = checkBudgets({ typingMs: roundedSummary(samples) }, budgets);

      expect(rows[1]).toMatchObject({ median, p95, budget: 16, over });
      expect(renderBudgetTable(rows)).toContain(
        `| Typing | ${median} ms | ${p95} ms | 16 ms | ${over ? "over" : "ok"} |`,
      );
    },
  );

  it("flags a median past its line and a metric that stopped reporting", () => {
    const rows = checkBudgets(
      {
        switchMs: { count: 3, min: 40, median: 60, p95: 140, max: 150 },
        typingMs: { count: 3, min: 10, median: 17, p95: 18, max: 18 },
      },
      budgets,
    );

    expect(rows.map((row) => [row.title, row.over])).toEqual([
      ["Switch", false],
      ["Typing", true],
      ["Idle", true],
    ]);
    expect(renderBudgetTable(rows)).toContain("| Idle | missing | missing | 2 % | over |");
  });
});
