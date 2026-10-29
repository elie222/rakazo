import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  shouldSkipPortableWorkspaceFile,
  workspaceSaveFindExpression,
} from "./workspace-save-policy.js";

describe("home save exclusions", () => {
  it.each([
    ".cache",
    ".npm",
    ".pnpm-store",
    ".yarn/cache",
    "node_modules",
    ".venv",
    "__pycache__",
    ".next",
    ".turbo",
  ])("prunes %s directories at any depth", (name) => {
    for (const prefix of ["", "project/nested/"]) {
      expect(shouldSkipPortableWorkspaceFile(`${prefix}${name}`, true)).toBe(true);
      expect(shouldSkipPortableWorkspaceFile(`${prefix}${name}/huge/data`)).toBe(true);
      expect(shouldSkipPortableWorkspaceFile(`${prefix}${name}`)).toBe(false);
    }
  });

  it.each(["core", "core.123", "debug.log", "nested/output.log"])(
    "excludes %s only as a regular file",
    (name) => {
      expect(shouldSkipPortableWorkspaceFile(name)).toBe(true);
      expect(shouldSkipPortableWorkspaceFile(name, true)).toBe(false);
      expect(shouldSkipPortableWorkspaceFile(`${name}/notes.txt`)).toBe(false);
    },
  );

  it.each([
    "packages/core/notes.txt",
    "core.txt",
    "core.abc",
    "a.log.txt",
    ".yarn/patches/fix.patch",
    ".yarn/releases/yarn.cjs",
    "project/Cache/data",
    "project/lock",
    "project/WidevineCdm/notes.txt",
  ])("keeps %s", (name) => {
    expect(shouldSkipPortableWorkspaceFile(name)).toBe(false);
  });

  it("retains the existing browser profile name matching", () => {
    for (const name of ["Cache", "Code Cache", "WidevineCdm"]) {
      expect(shouldSkipPortableWorkspaceFile(`.browser-profiles/chromium/${name}`, true)).toBe(
        true,
      );
      expect(shouldSkipPortableWorkspaceFile(`.browser-profiles/chromium/${name}/data`)).toBe(true);
    }
    for (const name of ["SingletonLock", "lock", ".parentlock", "BrowserMetrics"]) {
      expect(shouldSkipPortableWorkspaceFile(`.browser-profiles/chromium/${name}`)).toBe(true);
    }
    expect(shouldSkipPortableWorkspaceFile(".browser-profiles/chromium/Default/Cookies")).toBe(
      false,
    );
  });
});

const findVersion = spawnSync("find", ["--version"], { encoding: "utf8" });
describe.skipIf(findVersion.status !== 0 || !findVersion.stdout.includes("GNU"))(
  "GNU home save traversal",
  () => {
    it.each([
      ["Kubernetes", "-printf '%P\\0'", 1],
      ["Boat", "-fprintf \"$2.sizes\" '%s\\n' -printf '%p\\0'", 1],
      ["Railway", "-print0", 1],
      ["Boxd", "-printf '%P\\0%m\\0%s\\0'", 3],
    ])("prints regular files and prunes excluded directories for %s", async (_, action, fields) => {
      const root = await mkdtemp(path.join(tmpdir(), "rakazo-find-"));
      try {
        const home = path.join(root, "home with 'quotes'");
        const kept = [
          "notes.txt",
          "nested/with space/new\nline.txt",
          "packages/core/notes.txt",
          "debug.log/notes.txt",
          ".yarn/patches/fix.patch",
          ".browser-profiles/chromium/Default/Cookies",
          "project/Cache/data",
        ];
        const pruned = [
          ".cache",
          "project/node_modules",
          "project/.yarn/cache",
          ".browser-profiles/chromium/Default/Code Cache",
        ];
        const excluded = [
          ...pruned.map((dir) => `${dir}/unvisited/data`),
          "nested/debug.log",
          "nested/core.123",
          ".browser-profiles/chromium/SingletonLock",
        ];
        for (const name of [...kept, ...excluded]) {
          const target = path.join(home, name);
          await mkdir(path.dirname(target), { recursive: true });
          await writeFile(target, "data", { mode: 0o600 });
        }
        await symlink("notes.txt", path.join(home, "linked"));
        const trace = path.join(root, "visited");
        // Trace each visited entry before applying the production expression. A filter
        // that merely hides cache files would still visit their descendants.
        const output = execFileSync(
          "bash",
          [
            "-c",
            `cd "$1" && find . -fprintf "$2" '%P\\0' ${workspaceSaveFindExpression()} ${action}`,
            "workspace-save-test",
            home,
            trace,
          ],
          { encoding: "utf8" },
        );
        const records = output.split("\0").slice(0, -1);
        const names = records
          .filter((_, index) => index % fields === 0)
          .map((name) => name.replace(/^\.\//, ""));
        expect(names.sort()).toEqual([...kept].sort());
        for (const name of names) expect(shouldSkipPortableWorkspaceFile(name)).toBe(false);
        for (const name of excluded) expect(shouldSkipPortableWorkspaceFile(name)).toBe(true);
        const visited = (await readFile(trace, "utf8")).split("\0");
        for (const dir of pruned) {
          expect(visited).toContain(dir);
          expect(visited.some((name) => name.startsWith(`${dir}/`))).toBe(false);
        }
        if (fields === 3) {
          expect(records.filter((_, index) => index % fields === 1)).toEqual(kept.map(() => "600"));
          expect(records.filter((_, index) => index % fields === 2)).toEqual(kept.map(() => "4"));
        }
        if (action.includes("-fprintf")) {
          expect((await readFile(`${trace}.sizes`, "utf8")).trim().split("\n")).toEqual(
            kept.map(() => "4"),
          );
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  },
);
