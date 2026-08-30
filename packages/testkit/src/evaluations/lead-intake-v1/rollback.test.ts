import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isRollbackClean, performRollback, snapshotOrdinaryInventory } from "./rollback.js";

/**
 * EVAL-16: rollback must touch only evaluation-owned state and leave ordinary
 * Rakazo work intact, must be idempotent, and must never delete evidence.
 * `protectedDir` here stands in for "ordinary Rakazo work" — source files the
 * evaluation pack must never modify.
 */

describe("rollback — ordinary inventory protection", () => {
  const tempDirs: string[] = [];
  afterEach(() => {
    while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
  });

  function makeProtectedDir(): string {
    const dir = mkdtempSync(path.join(tmpdir(), "liqr-ordinary-"));
    tempDirs.push(dir);
    mkdirSync(path.join(dir, "nested"), { recursive: true });
    writeFileSync(path.join(dir, "a.ts"), "export const a = 1;\n", "utf8");
    writeFileSync(path.join(dir, "nested", "b.ts"), "export const b = 2;\n", "utf8");
    return dir;
  }

  it("reports a clean diff when nothing outside the evaluation was touched", () => {
    const dir = makeProtectedDir();
    const before = snapshotOrdinaryInventory(dir);
    const after = snapshotOrdinaryInventory(dir); // no mutation between snapshots
    const receipt = performRollback({
      campaignId: "rollback-test",
      policyHash: "a".repeat(64),
      ordinaryInventoryBefore: before,
      ordinaryInventoryAfter: after,
      revokedAt: "2026-08-29T00:00:00.000Z",
    });
    expect(isRollbackClean(receipt)).toBe(true);
    expect(receipt.evidence_preserved).toBe(true);
    expect(receipt.ordinary_inventory_diff).toEqual({ added: [], removed: [], changed: [] });
  });

  it("flags — rather than hides — an unrelated mutation outside evaluation scope", () => {
    const dir = makeProtectedDir();
    const before = snapshotOrdinaryInventory(dir);
    writeFileSync(path.join(dir, "a.ts"), "export const a = 999;\n", "utf8"); // simulated unrelated edit
    const after = snapshotOrdinaryInventory(dir);
    const receipt = performRollback({
      campaignId: "rollback-test",
      policyHash: "a".repeat(64),
      ordinaryInventoryBefore: before,
      ordinaryInventoryAfter: after,
    });
    expect(isRollbackClean(receipt)).toBe(false);
    expect(receipt.ordinary_inventory_diff.changed).toEqual(["a.ts"]);
  });

  it("detects files added or removed outside evaluation scope", () => {
    const dir = makeProtectedDir();
    const before = snapshotOrdinaryInventory(dir);
    writeFileSync(path.join(dir, "unexpected.ts"), "export const c = 3;\n", "utf8");
    const after = snapshotOrdinaryInventory(dir);
    const receipt = performRollback({
      campaignId: "rollback-test",
      policyHash: "a".repeat(64),
      ordinaryInventoryBefore: before,
      ordinaryInventoryAfter: after,
    });
    expect(isRollbackClean(receipt)).toBe(false);
    expect(receipt.ordinary_inventory_diff.added).toEqual(["unexpected.ts"]);
  });

  it("is idempotent: calling it twice on the same inputs yields the same diff and revocation", () => {
    const dir = makeProtectedDir();
    const before = snapshotOrdinaryInventory(dir);
    const after = snapshotOrdinaryInventory(dir);
    const first = performRollback({
      campaignId: "rollback-test",
      policyHash: "b".repeat(64),
      ordinaryInventoryBefore: before,
      ordinaryInventoryAfter: after,
      revokedAt: "2026-08-29T00:00:00.000Z",
    });
    const second = performRollback({
      campaignId: "rollback-test",
      policyHash: "b".repeat(64),
      ordinaryInventoryBefore: before,
      ordinaryInventoryAfter: after,
      revokedAt: "2026-08-29T00:00:00.000Z",
    });
    expect(first).toEqual(second);
  });

  it("never deletes evidence files — snapshot itself is read-only", () => {
    const dir = makeProtectedDir();
    const beforeCount = snapshotOrdinaryInventory(dir).length;
    performRollback({
      campaignId: "rollback-test",
      policyHash: "c".repeat(64),
      ordinaryInventoryBefore: snapshotOrdinaryInventory(dir),
      ordinaryInventoryAfter: snapshotOrdinaryInventory(dir),
    });
    expect(snapshotOrdinaryInventory(dir)).toHaveLength(beforeCount);
  });
});
