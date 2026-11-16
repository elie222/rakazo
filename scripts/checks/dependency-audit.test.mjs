import assert from "node:assert/strict";
import { test } from "node:test";
import { checkAuditCoverage } from "../check-dependency-audit.mjs";

const lockfile = `---
packages:
  pnpm@12: {}
---
importers:
  apps/api: {}
packages:
  foo@1:
    resolution: {integrity: example}
  bar@1: {}
  baz@1: {}
snapshots:
  foo@1: {}
`;

test("rejects a clean audit that covered only the package manager document", () => {
  assert.throws(
    () => checkAuditCoverage(lockfile, { metadata: { totalDependencies: 1 } }),
    /Incomplete/,
  );
});

test("accepts complete multi-document and single-document workspace audits", () => {
  const report = { metadata: { totalDependencies: 3 } };
  checkAuditCoverage(lockfile, report);
  checkAuditCoverage(lockfile.slice(lockfile.indexOf("importers:")), report);
});

test("missing inventory or report metadata cannot pass as clean", () => {
  assert.throws(() => checkAuditCoverage("", {}), /No lockfile package/);
  assert.throws(() => checkAuditCoverage(lockfile, {}), /Incomplete/);
});
