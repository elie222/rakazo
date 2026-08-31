import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { EVALUATION_PACK_ID } from "@rakazo/contracts";
import { canonicalSha256 } from "./evidence.js";

/**
 * Rollback for EVAL-16, scoped honestly to what this synthetic-phase harness
 * actually owns: its own campaign output directory. There is no live bot,
 * routine, connector, or computer inventory reachable from an offline test
 * process in this phase (none was ever provisioned — that's the point of R1),
 * so this module does not claim to touch any of that. What it does is real:
 * revoke the campaign's policy hash on paper, and prove — by hashing a
 * snapshot of source directories the evaluation must never touch — that
 * nothing outside the campaign's own designated output directory moved.
 *
 * "Do not delete evidence until the named retention decision" (01-EVALUATION-
 * PACK.md): rollback never deletes packets or the manifest. It only revokes
 * the policy that authorized producing more of them.
 */

export interface OrdinaryInventoryEntry {
  relativePath: string;
  sha256: string;
}

/** Stable, sorted snapshot of every file under `root`, for before/after comparison. */
export function snapshotOrdinaryInventory(root: string): OrdinaryInventoryEntry[] {
  const entries: OrdinaryInventoryEntry[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        walk(full);
      } else if (stat.isFile()) {
        entries.push({
          relativePath: path.relative(root, full),
          sha256: canonicalSha256(readFileSync(full, "utf8")),
        });
      }
    }
  };
  walk(root);
  return entries.sort((a, b) => (a.relativePath < b.relativePath ? -1 : 1));
}

export interface InventoryDiff {
  added: string[];
  removed: string[];
  changed: string[];
}

export function diffOrdinaryInventory(
  before: readonly OrdinaryInventoryEntry[],
  after: readonly OrdinaryInventoryEntry[],
): InventoryDiff {
  const beforeMap = new Map(before.map((entry) => [entry.relativePath, entry.sha256]));
  const afterMap = new Map(after.map((entry) => [entry.relativePath, entry.sha256]));
  const added = [...afterMap.keys()].filter((key) => !beforeMap.has(key));
  const removed = [...beforeMap.keys()].filter((key) => !afterMap.has(key));
  const changed = [...beforeMap.keys()].filter(
    (key) => afterMap.has(key) && afterMap.get(key) !== beforeMap.get(key),
  );
  return { added, removed, changed };
}

export function isInventoryDiffClean(diff: InventoryDiff): boolean {
  return diff.added.length === 0 && diff.removed.length === 0 && diff.changed.length === 0;
}

export interface RollbackReceiptBody {
  schema_version: "1.0";
  pack_id: typeof EVALUATION_PACK_ID;
  campaign_id: string;
  revoked_policy_hash: string;
  revoked_at: string;
  evidence_preserved: true;
  ordinary_inventory_diff: InventoryDiff;
}

export interface RollbackReceipt extends RollbackReceiptBody {
  receipt_sha256: string;
}

export interface PerformRollbackInput {
  campaignId: string;
  policyHash: string;
  ordinaryInventoryBefore: readonly OrdinaryInventoryEntry[];
  ordinaryInventoryAfter: readonly OrdinaryInventoryEntry[];
  revokedAt?: string;
}

/**
 * Idempotent by construction: called twice with the same inputs, this returns
 * the same diff and the same `evidence_preserved`/`revoked_policy_hash` — the
 * only field allowed to differ across calls is the timestamp, which does not
 * change what was actually revoked or preserved.
 */
export function performRollback(input: PerformRollbackInput): RollbackReceipt {
  const diff = diffOrdinaryInventory(input.ordinaryInventoryBefore, input.ordinaryInventoryAfter);
  const body: RollbackReceiptBody = {
    schema_version: "1.0",
    pack_id: EVALUATION_PACK_ID,
    campaign_id: input.campaignId,
    revoked_policy_hash: input.policyHash,
    revoked_at: input.revokedAt ?? new Date().toISOString(),
    evidence_preserved: true,
    ordinary_inventory_diff: diff,
  };
  return { ...body, receipt_sha256: canonicalSha256(body) };
}

export function isRollbackClean(receipt: RollbackReceipt): boolean {
  return isInventoryDiffClean(receipt.ordinary_inventory_diff);
}
