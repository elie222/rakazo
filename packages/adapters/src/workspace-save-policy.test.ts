import { describe, expect, it } from "vitest";
import { shouldSkipPortableWorkspaceFile } from "./workspace-save-policy.js";

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
