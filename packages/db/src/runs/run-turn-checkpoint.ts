import { z } from "zod";
import type { PrismaClient } from "../database/client.js";
import type { JsonColumnRow } from "../database/json-column.js";
import { readJsonColumn } from "../database/json-column.js";
import { ciphertextKeyId, decryptText, encryptText } from "../encryption/content-crypto.js";
import { contentEncryptionOf } from "../encryption/content-encryption.js";
import { Prisma } from "../generated/prisma/client.js";

// A reserved effect kind/status keeps transcripts out of approval queues and
// client events while reusing run/space cascades and latest-only upsert storage.
export const RUN_TURN_CHECKPOINT_KIND = "runtime_checkpoint";
const keyOf = (runId: string) => JSON.stringify([RUN_TURN_CHECKPOINT_KIND, runId]);
const locationOf = (runId: string) => ({
  table: "external_effects",
  column: "result",
  rowId: keyOf(runId),
  owner: runId,
});

/** The row holding a run's saved turn, for reporting a part of it this release cannot read. */
export function runTurnCheckpointRow(runId: string): JsonColumnRow {
  const { table, column, rowId } = locationOf(runId);
  return { table, column, id: rowId };
}

const checkpointWhere = (run: { id: string; spaceId: string }) => ({
  runId: run.id,
  spaceId: run.spaceId,
  kind: RUN_TURN_CHECKPOINT_KIND,
  status: RUN_TURN_CHECKPOINT_KIND,
  idempotencyKey: keyOf(run.id),
});

const checkpointRequest = z.object({
  introEffects: z
    .array(z.object({ id: z.string(), kind: z.string(), idempotencyKey: z.string() }))
    .optional(),
});

export async function loadRunTurnCheckpoint(
  prisma: PrismaClient,
  run: { id: string; spaceId: string },
): Promise<string | undefined> {
  return (await loadRunTurnState(prisma, run)).turnCheckpoint;
}

export async function loadRunTurnState(prisma: PrismaClient, run: { id: string; spaceId: string }) {
  const rows = await prisma.externalEffect.findMany({
    where: checkpointWhere(run),
    select: { result: true, request: true },
  });
  const { introEffects = [] } = readJsonColumn(
    checkpointRequest,
    rows[0]?.request ?? {},
    { ...runTurnCheckpointRow(run.id), column: "request" },
    "reject",
  );
  const blob = rows[0]?.result;
  return {
    turnCheckpoint: typeof blob === "string" ? await openCheckpoint(prisma, run, blob) : undefined,
    introEffects,
  };
}

async function openCheckpoint(
  prisma: PrismaClient,
  run: { id: string; spaceId: string },
  blob: string,
): Promise<string> {
  const keyId = ciphertextKeyId(blob);
  if (!keyId) return blob;
  const encryption = contentEncryptionOf(prisma);
  if (!encryption) throw new Error("Turn checkpoint encryption is unavailable");
  const key = await encryption.ring.byId(keyId);
  if (key.spaceId !== run.spaceId) throw new Error("Turn checkpoint space mismatch");
  return decryptText(key, locationOf(run.id), blob);
}

export async function saveRunTurnCheckpoint(
  prisma: PrismaClient,
  run: { id: string; spaceId: string },
  leaseOwner: string,
  leaseFence: number,
  blob: string,
): Promise<void> {
  const encryption = contentEncryptionOf(prisma);
  const result = encryption?.ring.encryptWrites
    ? encryptText(await encryption.ring.current(run.spaceId), locationOf(run.id), blob)
    : blob;
  await prisma.$transaction(async (tx) => {
    // Lock and fence the run before writing: cancellation/finalization must either
    // follow this write and remove it, or win first and reject it.
    const locked = await tx.run.updateMany({
      where: { id: run.id, spaceId: run.spaceId, status: "running", leaseOwner, leaseFence },
      data: { leaseFence },
    });
    if (locked.count !== 1) throw new Error("Run lease expired before checkpoint");
    await tx.externalEffect.upsert({
      where: { idempotencyKey: keyOf(run.id) },
      create: {
        spaceId: run.spaceId,
        runId: run.id,
        kind: RUN_TURN_CHECKPOINT_KIND,
        status: RUN_TURN_CHECKPOINT_KIND,
        idempotencyKey: keyOf(run.id),
        request: {},
        result,
      },
      update: { result },
    });
  });
}

/** Drop a running run's saved turn, only while this worker still holds its lease. */
export async function dropRunTurnCheckpoint(
  prisma: PrismaClient,
  run: { id: string; spaceId: string },
  leaseOwner: string,
  leaseFence: number,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const locked = await tx.run.updateMany({
      where: { id: run.id, spaceId: run.spaceId, status: "running", leaseOwner, leaseFence },
      data: { leaseFence },
    });
    if (locked.count !== 1) throw new Error("Run lease expired before checkpoint");
    // Keep the intro receipts when a later pause has no resumable transcript.
    const where = checkpointWhere(run);
    const removed = await tx.externalEffect.deleteMany({
      where: { ...where, request: { equals: {} } },
    });
    if (removed.count === 0) {
      await tx.externalEffect.updateMany({ where, data: { result: Prisma.DbNull } });
    }
  });
}

/** Snapshot the receipt identities before the run can start executing the user's task. */
export async function retireIntroTurnCheckpoint(
  tx: Prisma.TransactionClient,
  run: { id: string; spaceId: string },
): Promise<void> {
  const introEffects = await tx.externalEffect.findMany({
    where: { runId: run.id, spaceId: run.spaceId, kind: { not: RUN_TURN_CHECKPOINT_KIND } },
    select: { id: true, kind: true, idempotencyKey: true },
  });
  const where = checkpointWhere(run);
  if (introEffects.length === 0) {
    await tx.externalEffect.deleteMany({ where });
    return;
  }
  await tx.externalEffect.upsert({
    where: { idempotencyKey: where.idempotencyKey },
    create: { ...where, request: { introEffects } },
    update: { request: { introEffects }, result: Prisma.DbNull },
  });
}

/** Call after the terminal status write; its fence rejects later checkpoint writes. */
export async function clearRunTurnCheckpoints(
  prisma: Pick<PrismaClient, "externalEffect">,
  runIds: readonly string[],
): Promise<void> {
  if (runIds.length === 0) return;
  await prisma.externalEffect.deleteMany({
    where: {
      runId: { in: [...runIds] },
      kind: RUN_TURN_CHECKPOINT_KIND,
      status: RUN_TURN_CHECKPOINT_KIND,
    },
  });
}
