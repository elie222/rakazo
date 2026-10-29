import { getLogger } from "@rakazo/logging";
import type { PrismaClient } from "./generated/prisma/client.js";

/**
 * How a computer run ended.
 * - `stopped`: stopped on request (the stop button, a computer switch, an archived bot).
 * - `idle` / `active_limit`: idle shutdown, or the cap on one continuous stretch.
 * - `replaced`: torn down by update, recovery or reset; the replacement starts a new run.
 * - `gone`: the provider had already stopped or lost the sandbox. The end is when Rakazo noticed.
 * - `deleted`: destroyed with its computer, bot, space or account.
 * - `reconciled`: the end was never seen; a later start or the reconciler found the computer
 *   no longer running. The end is when that was detected.
 */
export type ComputerRunEnd =
  | "stopped"
  | "idle"
  | "active_limit"
  | "replaced"
  | "gone"
  | "deleted"
  | "reconciled";

type RunsClient = Pick<PrismaClient, "computerRun">;

/**
 * Records the run that began at the computer's `runningSince`, and closes an earlier run whose
 * end was missed with `previousEnd`. Idempotent: a reconnect within the same stretch is a no-op.
 * Usage recording never fails the lifecycle transition that calls it.
 */
export async function recordComputerRunStart(
  prisma: RunsClient,
  computer: {
    id: string;
    spaceId: string;
    userId: string;
    kind: string;
    providerRef: string | null;
  },
  startedAt: Date,
  previousEnd: ComputerRunEnd = "reconciled",
): Promise<void> {
  // Host computers run on the user's own machine, and Electron, not Rakazo, sees them stop.
  if (computer.kind === "desktop") return;
  try {
    await prisma.computerRun.updateMany({
      where: { computerId: computer.id, endedAt: null, startedAt: { lt: startedAt } },
      data: { endedAt: startedAt, endReason: previousEnd },
    });
    await prisma.computerRun.createMany({
      data: [
        {
          computerId: computer.id,
          spaceId: computer.spaceId,
          userId: computer.userId,
          kind: computer.kind,
          providerRef: computer.providerRef,
          startedAt,
        },
      ],
      skipDuplicates: true,
    });
  } catch (error) {
    getLogger().error("computer.run_record_failed", error, {
      "computer.id": computer.id,
      transition: "start",
    });
  }
}

/**
 * Closes the run of the stretch that began at `runningSince`, read before the stop. A restart
 * that lands before this write opens a run with a newer start, which stays open. Without a
 * start (deletion, or a row an older release activated) it closes every open run. Never fails
 * the transition that calls it.
 */
export async function recordComputerRunEnd(
  prisma: RunsClient,
  computer: { id: string; runningSince?: Date | null },
  reason: ComputerRunEnd,
): Promise<void> {
  const endedAt = new Date();
  try {
    await prisma.computerRun.updateMany({
      where: {
        computerId: computer.id,
        endedAt: null,
        startedAt: computer.runningSince ?? { lte: endedAt },
      },
      data: { endedAt, endReason: reason },
    });
  } catch (error) {
    getLogger().error("computer.run_record_failed", error, {
      "computer.id": computer.id,
      transition: "end",
      reason,
    });
  }
}

/**
 * Repairs what the lifecycle did not record. Closes open runs whose computer row is gone, is no
 * longer running, or has begun a newer stretch, and opens the run of a running computer that
 * has none. Covers a crash or deploy between a provider call and its usage write, a failed
 * usage write, and paths that stop a computer without recording it.
 */
export async function reconcileComputerRuns(
  prisma: Pick<PrismaClient, "$executeRaw">,
  now = new Date(),
): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "computer_runs" AS r
    SET "endedAt" = GREATEST(${now}::timestamp(3), r."startedAt"),
        "endReason" = CASE WHEN c."id" IS NULL THEN 'deleted' ELSE 'reconciled' END
    FROM "computer_runs" AS o
    LEFT JOIN "computers" AS c ON c."id" = o."computerId"
    WHERE r."id" = o."id"
      AND o."endedAt" IS NULL
      AND (
        c."id" IS NULL
        OR c."state" NOT IN ('running', 'booting', 'suspending')
        OR c."runningSince" IS DISTINCT FROM o."startedAt"
      )`;
  // A booting computer may still carry the start of its previous stretch, so only rows that
  // finished starting count. Host computers are never recorded (see recordComputerRunStart).
  await prisma.$executeRaw`
    INSERT INTO "computer_runs" ("id", "computerId", "spaceId", "userId", "kind", "providerRef", "startedAt")
    SELECT gen_random_uuid()::text, c."id", c."spaceId", c."userId", c."kind", c."providerRef", c."runningSince"
    FROM "computers" AS c
    WHERE c."state" IN ('running', 'suspending')
      AND c."runningSince" IS NOT NULL
      AND c."kind" <> 'desktop'
      AND NOT EXISTS (
        SELECT 1 FROM "computer_runs" AS r
        WHERE r."computerId" = c."id" AND r."startedAt" = c."runningSince"
      )
    ON CONFLICT ("computerId", "startedAt") DO NOTHING`;
}
