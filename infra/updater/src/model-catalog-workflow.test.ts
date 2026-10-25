import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";

const workflow = parse(
  readFileSync(
    path.resolve(import.meta.dirname, "../../../.github/workflows/model-catalog-bump.yml"),
    "utf8",
  ),
) as { jobs: { publish: { steps: Array<{ name?: string; run?: string }> } } };
const applyScript = workflow.jobs.publish.steps.find((step) => step.name === "Apply bump patch")!
  .run!;

describe("model catalog artifact boundary", () => {
  let root: string;
  let artifact: string;
  const manifest = "packages/adapters/package.json";
  function git(...args: string[]) {
    return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: "pipe" });
  }
  function apply() {
    return spawnSync("bash", ["-c", applyScript], {
      cwd: root,
      env: { ...process.env, BUMP_DIR: artifact },
      encoding: "utf8",
    });
  }
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "rakazo-catalog-artifact-"));
    artifact = path.join(root, "artifact");
    mkdirSync(path.join(root, "packages/adapters"), { recursive: true });
    writeFileSync(path.join(root, manifest), '{"version":"1"}\n');
    writeFileSync(path.join(root, "pnpm-lock.yaml"), "version: 1\n");
    git("init", "-q");
    git("add", ".");
    git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-qm",
      "fixture",
    );
    mkdirSync(artifact);
    writeFileSync(path.join(root, manifest), '{"version":"2"}\n');
    writeFileSync(path.join(root, "pnpm-lock.yaml"), "version: 2\n");
    writeFileSync(path.join(artifact, "bump.patch"), git("diff"));
    git("checkout", "--", manifest, "pnpm-lock.yaml");
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("stages the permitted regular files and ignores paths outside the allowlist", () => {
    writeFileSync(path.join(root, "unexpected-script"), "untrusted\n");
    git("add", "unexpected-script");
    writeFileSync(
      path.join(artifact, "bump.patch"),
      readFileSync(path.join(artifact, "bump.patch"), "utf8") + git("diff", "--cached"),
    );
    git("reset", "-q");
    rmSync(path.join(root, "unexpected-script"));
    expect(apply().status).toBe(0);
    expect(git("diff", "--cached", "--name-only").trim().split("\n")).toEqual([
      manifest,
      "pnpm-lock.yaml",
    ]);
    expect(git("show", `:${manifest}`)).toBe('{"version":"2"}\n');
    expect(git("show", ":pnpm-lock.yaml")).toBe("version: 2\n");
    expect(git("status", "--porcelain", "--", "unexpected-script")).toBe("");
  });

  it("rejects additional artifact entries before touching the checkout", () => {
    const originalConfig = readFileSync(path.join(root, ".git/config"), "utf8");
    mkdirSync(path.join(artifact, ".git"));
    writeFileSync(path.join(artifact, ".git/config"), "[core]\nfsmonitor=untrusted\n");
    expect(apply().status).not.toBe(0);
    expect(readFileSync(path.join(root, ".git/config"), "utf8")).toBe(originalConfig);
    expect(git("diff", "--cached")).toBe("");
  });

  it("rejects a symlink in place of the patch", () => {
    rmSync(path.join(artifact, "bump.patch"));
    symlinkSync(path.join(root, "pnpm-lock.yaml"), path.join(artifact, "bump.patch"));
    expect(apply().status).not.toBe(0);
    expect(git("diff", "--cached")).toBe("");
  });

  it("rejects a patch that replaces a permitted file with a symlink", () => {
    rmSync(path.join(root, manifest));
    symlinkSync("../../pnpm-lock.yaml", path.join(root, manifest));
    writeFileSync(path.join(artifact, "bump.patch"), git("diff"));
    git("checkout", "--", manifest);
    expect(apply().status).not.toBe(0);
  });
});
