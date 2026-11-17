import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const SCHEMA = new URL("../../packages/db/prisma/schema.prisma", import.meta.url);

// Hand-written leases and claims from before `withLease`. Move one onto it, then drop it here.
// The groups commented below as not for `withLease` stay: they are not long work in one process.
const EXISTING = new Set([
  "ScimConnectionBinding.decommissionLeaseId",
  "ScimConnectionBinding.decommissionLeaseExpiresAt",
  "PluginSubmission.claim",
  "Space.deletionClaimId",
  "Space.deletionAttemptId",
  "AuditEventForwarding.nextAttemptAt",
  "Run.leaseOwner",
  "Run.leaseFence",
  "Run.leaseExpiresAt",
  "SteeringMessage.claimedAt",
  "Attempt.fence",
  "ModelOAuthSession.leaseExpiresAt",
  "MessagingOutbound.claimedAt",
  "ModelCreditEntry.reconciliationAttempts",
  // Moved onto `withLease`; kept only while the previous release still claims them.
  "BillingAccount.checkoutLeaseId",
  "BillingAccount.checkoutLeaseExpiresAt",
  "CloudAgent.leaseToken",
  "CloudAgent.leaseExpiresAt",
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
  // Not long work in one process, so not for `withLease`: a computer's execution lease outlives the
  // process that took it (a takeover keeps it for hours and a later worker takes it back by run id),
  // it is taken inside other transactions, and those transactions end it by run id.
  "ComputerExecutionLease.fence",
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
    "Coordinate long work across processes with `withLease` from @rakazo/db (packages/db/src/database/leases.ts), " +
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
