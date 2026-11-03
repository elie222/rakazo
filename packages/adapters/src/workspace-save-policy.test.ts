import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  isTaggedCacheDirectory,
  shouldSkipPortableWorkspaceFile,
  workspaceSaveFindCommand,
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
const root = process.getuid?.() === 0;
const CACHE_TAG = "Signature: 8a477f597d28d172789f06886806bc55\n# Created by a build tool\n";

describe.skipIf(findVersion.status !== 0 || !findVersion.stdout.includes("GNU"))(
  "GNU home save traversal",
  () => {
    it.each([
      ["Kubernetes", "-printf '%P\\0'", 1],
      ["Boat", "-fprintf \"$2.sizes\" '%s\\n' -printf '%p\\0'", 1],
      ["Railway", "-print0", 1],
      ["Boxd", "-printf '%P\\0%m\\0%s\\0'", 3],
    ])("prints regular files and prunes excluded directories for %s", async (_, action, fields) => {
      const scratch = await mkdtemp(path.join(tmpdir(), "rakazo-find-"));
      try {
        const home = path.join(scratch, "home with 'quotes'");
        const kept = [
          "notes.txt",
          "nested/with space/new\nline.txt",
          "packages/core/notes.txt",
          "debug.log/notes.txt",
          ".yarn/patches/fix.patch",
          ".browser-profiles/chromium/Default/Cookies",
          "project/Cache/data",
          "untagged/CACHEDIR.TAG",
          "untagged/data",
        ];
        const pruned = [
          ".cache",
          "project/node_modules",
          "project/.yarn/cache",
          ".browser-profiles/chromium/Default/Code Cache",
          "rust/target",
          "odd [dir]*?/target",
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
        for (const dir of ["rust/target", "odd [dir]*?/target"]) {
          await writeFile(path.join(home, dir, "CACHEDIR.TAG"), CACHE_TAG);
        }
        // Without the glob escaping, "odd [dir]*?/target" would also match this one.
        await mkdir(path.join(home, "odd d!/target"), { recursive: true });
        await writeFile(path.join(home, "odd d!/target/kept.txt"), "data");
        kept.push("odd d!/target/kept.txt");
        await symlink("notes.txt", path.join(home, "linked"));
        // A walk that descends into a pruned directory fails to read this subdirectory.
        if (!root) {
          for (const dir of pruned) await chmod(path.join(home, dir, "unvisited"), 0o000);
        }
        const result = spawnSync(
          "bash",
          [
            "-c",
            `cd "$1" && ${workspaceSaveFindCommand()} ${action}`,
            "workspace-save-test",
            home,
            path.join(scratch, "out"),
          ],
          { encoding: "utf8" },
        );
        if (!root) {
          for (const dir of pruned) await chmod(path.join(home, dir, "unvisited"), 0o700);
        }
        expect(result.stderr).toBe("");
        expect(result.status).toBe(0);
        const records = result.stdout.split("\0").slice(0, -1);
        const names = records
          .filter((_, index) => index % fields === 0)
          .map((name) => name.replace(/^\.\//, ""));
        expect(names.sort()).toEqual([...kept].sort());
        if (fields === 3) {
          expect(records.filter((_, index) => index % fields === 1)).toEqual(kept.map(() => "600"));
        }
        if (action.includes("-fprintf")) {
          expect(
            (await readFile(path.join(scratch, "out.sizes"), "utf8")).trim().split("\n"),
          ).toHaveLength(kept.length);
        }
      } finally {
        await rm(scratch, { recursive: true, force: true });
      }
    });
  },
);

describe("tagged cache directories", () => {
  it("recognizes only a tag that starts with the signature", async () => {
    const scratch = await mkdtemp(path.join(tmpdir(), "rakazo-cachedir-"));
    try {
      const write = async (dir: string, content?: string) => {
        await mkdir(path.join(scratch, dir), { recursive: true });
        if (content !== undefined)
          await writeFile(path.join(scratch, dir, "CACHEDIR.TAG"), content);
        return isTaggedCacheDirectory(path.join(scratch, dir));
      };
      expect(await write("tagged", CACHE_TAG)).toBe(true);
      expect(await write("unsigned", "my notes")).toBe(false);
      expect(await write("short", CACHE_TAG.slice(0, 20))).toBe(false);
      expect(await write("missing")).toBe(false);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });
});
