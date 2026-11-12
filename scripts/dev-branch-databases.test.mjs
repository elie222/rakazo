import assert from "node:assert/strict";
import { test } from "node:test";
import { branchDatabaseName, branchDatabaseOwner } from "./dev-branch-databases.mjs";

test("catalog metadata cannot authorize a different database or directory", () => {
  const branch = "feature/example";
  const owner = JSON.stringify({ repo: "fixture-repo", branch });
  const name = branchDatabaseName("rakazo", branch);
  assert.equal(branchDatabaseOwner({ name, owner }, "rakazo", "fixture-repo"), branch);
  for (const forged of [
    'other"; SELECT 1; --',
    "../../unrelated",
    "..\\..\\unrelated",
    branchDatabaseName("another_database", branch),
    branchDatabaseName("rakazo", "another-branch"),
  ]) {
    assert.equal(branchDatabaseOwner({ name: forged, owner }, "rakazo", "fixture-repo"), undefined);
  }
  for (const metadata of ["null", "{}", "invalid", JSON.stringify({ repo: "other", branch })]) {
    assert.equal(
      branchDatabaseOwner({ name, owner: metadata }, "rakazo", "fixture-repo"),
      undefined,
    );
  }
});

test("generated names remain bounded path components even with unusual shared names", () => {
  for (const shared of ["../../shared", "..\\shared", 'shared"; SELECT 1; --', "shared%22", "db"]) {
    const name = branchDatabaseName(shared, "feature/a.b");
    assert.match(name, /^[A-Za-z0-9_-]+$/);
    assert.ok(Buffer.byteLength(name) <= 63);
  }
  assert.notEqual(branchDatabaseName("a/b", "branch"), branchDatabaseName("a_b", "branch"));
  assert.notEqual(branchDatabaseName("db", "a/b"), branchDatabaseName("db", "a-b"));
  assert.equal(branchDatabaseName("rakazo", "main"), "rakazo_main_0d6e4079");
});
