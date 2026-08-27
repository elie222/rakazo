import { describe, expect, it } from "vitest";
import {
  applyFailureMessage,
  buildCheckResult,
  parseBehindCount,
  parsePorcelain,
  UPDATE_BRANCH,
  UPDATE_REMOTE,
  unavailableCheck,
} from "./software-update.js";

describe("parsePorcelain", () => {
  it("treats empty status as clean", () => {
    expect(parsePorcelain("")).toEqual({ dirty: false, changedFiles: [] });
    expect(parsePorcelain("\n")).toEqual({ dirty: false, changedFiles: [] });
  });

  it("parses changed paths and marks dirty", () => {
    const status = [" M apps/web/src/pages/Shell.tsx", "?? notes.txt", ""].join("\n");
    expect(parsePorcelain(status)).toEqual({
      dirty: true,
      changedFiles: ["apps/web/src/pages/Shell.tsx", "notes.txt"],
    });
  });

  it("uses the destination path for renames", () => {
    expect(parsePorcelain("R  old.txt -> new.txt\n")).toEqual({
      dirty: true,
      changedFiles: ["new.txt"],
    });
  });
});

describe("parseBehindCount", () => {
  it("parses a non-negative count", () => {
    expect(parseBehindCount("0\n")).toBe(0);
    expect(parseBehindCount("12")).toBe(12);
  });

  it("falls back to 0 for junk", () => {
    expect(parseBehindCount("")).toBe(0);
    expect(parseBehindCount("nope")).toBe(0);
    expect(parseBehindCount("-3")).toBe(0);
  });
});

describe("buildCheckResult", () => {
  it("marks up to date when behindBy is 0", () => {
    const result = buildCheckResult({
      currentCommit: "aaa",
      targetCommit: "aaa",
      behindBy: 0,
      dirty: false,
      changedFiles: [],
      branch: "main",
      remote: "origin",
    });
    expect(result).toMatchObject({
      available: true,
      isUpToDate: true,
      behindBy: 0,
      canAutoUpdate: false,
    });
  });

  it("allows auto update when behind and clean", () => {
    const result = buildCheckResult({
      currentCommit: "aaa",
      targetCommit: "bbb",
      behindBy: 3,
      dirty: false,
      changedFiles: [],
      branch: "feature",
      remote: "origin",
    });
    expect(result).toMatchObject({
      available: true,
      isUpToDate: false,
      behindBy: 3,
      canAutoUpdate: true,
    });
  });

  it("blocks auto update when dirty even if behind", () => {
    const result = buildCheckResult({
      currentCommit: "aaa",
      targetCommit: "bbb",
      behindBy: 2,
      dirty: true,
      changedFiles: ["x"],
      branch: "main",
      remote: "origin",
    });
    expect(result.canAutoUpdate).toBe(false);
    expect(result.isUpToDate).toBe(false);
  });
});

describe("unavailableCheck", () => {
  it("does not claim up to date", () => {
    expect(unavailableCheck()).toMatchObject({
      available: false,
      isUpToDate: false,
      canAutoUpdate: false,
      branch: UPDATE_BRANCH,
      remote: UPDATE_REMOTE,
    });
  });
});

describe("applyFailureMessage", () => {
  it("returns short safe messages", () => {
    expect(applyFailureMessage("dirty").message).toBe("Local changes. Stash or commit first.");
    expect(applyFailureMessage("not-git").message).toBe("Updates unavailable.");
    expect(applyFailureMessage("not-ff").message).toBe("Cannot fast-forward. Update manually.");
    expect(applyFailureMessage("failed").message).toBe("Update failed.");
    expect(applyFailureMessage("dirty").success).toBe(false);
  });
});
