import { execFileSync } from "node:child_process";
import path from "node:path";
import { expect, it } from "vitest";

it("lists eval cases without importing a generated database client or runtime adapters", () => {
  const guard = `
    import { registerHooks } from 'node:module';
    registerHooks({
      resolve(specifier, context, nextResolve) {
        if (specifier === '@rakazo/db' || specifier === '@rakazo/adapters') {
          throw new Error('Runtime imported before database generation');
        }
        return nextResolve(specifier, context);
      }
    });
  `;
  const output = execFileSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--import",
      `data:text/javascript,${encodeURIComponent(guard)}`,
      path.resolve(import.meta.dirname, "../cli/evals.ts"),
      "--list",
    ],
    { encoding: "utf8", timeout: 20_000 },
  );
  expect(output).toContain("workspace-memory-isolation:");
  expect(output.trim().split("\n")).toHaveLength(16);
});

it("records explicit not-run reasons without live execution", async () => {
  const { mkdtempSync, readFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(path.join(tmpdir(), "eval-offline-"));
  const output = path.join(dir, "report.json");
  try {
    expect(() =>
      execFileSync(
        process.execPath,
        [
          "--import",
          "tsx",
          path.resolve(import.meta.dirname, "../cli/evals.ts"),
          "--strategy",
          "current",
          "--strategy",
          "retrieval",
          "--suite",
          "history",
          "--case",
          "history-100-exact",
          "--trials",
          "1",
          "--output",
          output,
        ],
        { encoding: "utf8", stdio: "pipe", timeout: 20000 },
      ),
    ).toThrow();
    const report = JSON.parse(readFileSync(output, "utf8"));
    expect(report.trials[0].status).toBe("not-run");
    expect(report.trials[0].reason).toContain("--live");
    expect(report.trials[0].costUsd).toBeNull();
    expect(report.trials).toHaveLength(2);
    expect(report.summary.map((row: { strategy: string }) => row.strategy)).toEqual([
      "current",
      "retrieval",
    ]);
    expect(report.spendCapUsd).toBe(5);
    expect(report.caseFixtureVersions).toEqual({ "history-100-exact": "history-v1-seed-73" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
