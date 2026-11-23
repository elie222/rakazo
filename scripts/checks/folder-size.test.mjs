import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { folderCounts, LIMIT, oversized, readBaseline, trackedFiles } from "./folder-size.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test(`no folder holds more than ${LIMIT} code files, or its frozen count`, () => {
  const over = oversized(folderCounts(trackedFiles(root)), readBaseline());
  assert.deepEqual(
    over,
    [],
    `Group these folders' files into topic folders (limit ${LIMIT} code files each, excluding tests and evals). Folders already past it are frozen in scripts/checks/folder-size.baseline.json and may only shrink; after shrinking one, run node scripts/checks/folder-size.mjs --tighten.\n${over.map(({ folder, count, allowed }) => `  ${folder}: ${count} files, allowed ${allowed}`).join("\n")}`,
  );
});

test("the baseline only freezes folders past the limit, in order", () => {
  const baseline = readBaseline();
  const folders = Object.keys(baseline);
  assert.deepEqual(folders, [...folders].sort(), "Keep the baseline sorted");
  for (const [folder, allowed] of Object.entries(baseline)) {
    assert.ok(allowed > LIMIT, `${folder}: a folder within the limit needs no entry`);
  }
});

test("counts direct children and skips tests, evals, generated files and vendor files", () => {
  const counts = folderCounts([
    "a/one.ts",
    "a/two.test.ts",
    "a/three.spec.tsx",
    "a/test_capture.py",
    "a/notes.md",
    "a/capture.c",
    "a/b/three.ts",
    "db/generated/client.ts",
    "packages/testkit/src/cli/evals.ts",
    "packages/testkit/src/cli/approval-eval.ts",
    "packages/testkit/src/cli/flows.ts",
    "packages/testkit/src/evals/suites/recall.ts",
    "packages/ui-web/src/components/ui/button.tsx",
  ]);
  assert.deepEqual(Object.fromEntries(counts), { a: 2, "a/b": 1, "packages/testkit/src/cli": 1 });
  assert.deepEqual(oversized(new Map([["a", LIMIT + 2]]), { a: LIMIT + 5 }), []);
  assert.deepEqual(oversized(new Map([["a", LIMIT + 2]]), {}), [
    { folder: "a", count: LIMIT + 2, allowed: LIMIT },
  ]);
});
