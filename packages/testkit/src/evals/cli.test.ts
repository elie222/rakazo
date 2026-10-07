import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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

it("fingerprints a tracked report diff larger than the child-process default buffer", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "eval-large-diff-"));
  const output = path.join(dir, "report.json");
  const git = (args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  try {
    git(["init", "--quiet"]);
    writeFileSync(path.join(dir, "notes.md"), "before\n");
    git(["add", "notes.md"]);
    git([
      "-c",
      "user.name=Synthetic Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--quiet",
      "-m",
      "Synthetic baseline",
    ]);
    writeFileSync(path.join(dir, "notes.md"), `${"synthetic line ".repeat(100)}\n`.repeat(1200));
    const fingerprint = (cwd: string) => {
      expect(() =>
        execFileSync(
          process.execPath,
          [
            "--import",
            import.meta.resolve("tsx"),
            path.resolve(import.meta.dirname, "../cli/evals.ts"),
            "--suite",
            "history",
            "--case",
            "history-100-exact",
            "--trials",
            "1",
            "--output",
            output,
          ],
          { cwd, stdio: "pipe", timeout: 20_000 },
        ),
      ).toThrow();
      return JSON.parse(readFileSync(output, "utf8")).workingDiffHash;
    };
    const packageDir = path.join(dir, "packages/testkit");
    mkdirSync(packageDir, { recursive: true });
    const rootHash = fingerprint(dir);
    expect(rootHash).toMatch(/^[a-f0-9]{64}$/);
    expect(fingerprint(packageDir)).toBe(rootHash);
    const source = path.join(packageDir, "src/new source.ts");
    mkdirSync(path.dirname(source), { recursive: true });
    writeFileSync(source, "export const synthetic = 1;\n");
    const first = fingerprint(dir);
    expect(first).not.toBe(rootHash);
    expect(fingerprint(packageDir)).toBe(first);
    writeFileSync(source, "export const synthetic = 2;\n");
    const changed = fingerprint(dir);
    expect(changed).not.toBe(first);
    expect(fingerprint(packageDir)).toBe(changed);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
