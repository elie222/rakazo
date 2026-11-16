import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const SCHEMA = new URL("../../packages/db/prisma/schema.prisma", import.meta.url);

// Hand-written leases and claims from before `withLease`. Move one onto it, then drop it here.
const EXISTING = new Set([
  "ScimConnectionBinding.decommissionLeaseId",
  "ScimConnectionBinding.decommissionLeaseExpiresAt",
  "BillingAccount.checkoutLeaseId",
  "BillingAccount.checkoutLeaseExpiresAt",
  "PluginSubmission.claim",
  "Space.deletionClaimId",
  "Space.deletionAttemptId",
  "AuditEventForwarding.nextAttemptAt",
  "Run.leaseOwner",
  "Run.leaseFence",
  "Run.leaseExpiresAt",
  "SteeringMessage.claimedAt",
  "Attempt.fence",
  "CloudAgent.leaseToken",
  "CloudAgent.leaseExpiresAt",
  "Computer.executionLeaseExpiresAt",
  "Computer.executionFence",
  "ComputerExecutionLease.fence",
  "ModelOAuthSession.leaseExpiresAt",
  "MessagingOutbound.claimedAt",
  "ModelCreditEntry.reconciliationAttempts",
  // Moved onto `withLease`; kept only while the previous release still claims them.
  "HomeDeletionNotice.claimId",
  "HomeDeletionNotice.claimExpiresAt",
  // The primitive's own table.
  "Lease.fence",
  // Not long work in one process, so not for `withLease`: a person's page holds computer control
  // across requests, heartbeats renew it on any instance, and a lapsed one still counts until the
  // computer stops taking that person's input.
  "Computer.controlLeaseId",
  "Computer.controlLeaseExpiresAt",
  "Computer.controlFence",
]);

const LEASE_LIKE = /(?<!re)lease|claim|attempt|fence|lockedAt/i;

/** `Model.field` for each scalar column whose name looks like a lease, claim or attempt counter. */
function leaseColumns(schema) {
  const models = new Set([...schema.matchAll(/^model (\w+)/gm)].map((match) => match[1]));
  const columns = [];
  let model;
  for (const line of schema.split("\n")) {
    const opened = line.match(/^model (\w+)/);
    if (opened) model = opened[1];
    else if (line.startsWith("}")) model = undefined;
    const field = model && line.match(/^\s+(\w+)\s+(\w+)/);
    if (!field || models.has(field[2])) continue;
    if (LEASE_LIKE.test(field[1])) columns.push(`${model}.${field[1]}`);
  }
  return columns;
}

test("adds no hand-written lease, claim or attempt column", () => {
  const added = leaseColumns(readFileSync(SCHEMA, "utf8")).filter(
    (column) => !EXISTING.has(column),
  );
  assert.deepEqual(
    added,
    [],
    "Coordinate long work across processes with `withLease` from @rakazo/db (packages/db/src/leases.ts), " +
      "and retries with the job queue's attempts and backoff, instead of new lease, claim or attempt columns.",
  );
});

test("finds lease-like scalar columns, not relations or release times", () => {
  const schema = `model Job {
  id          String   @id
  leaseOwner  String?
  claimedAt   DateTime?
  attempts    Attempt[]
  releasedAt  DateTime?
  lockedAt    DateTime?
}
model Attempt {
  id String @id
}`;
  assert.deepEqual(leaseColumns(schema), ["Job.leaseOwner", "Job.claimedAt", "Job.lockedAt"]);
});
