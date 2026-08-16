import { type JobPublisher, routineWakeupJob, runContinueJob } from "@rakazo/adapter-kit";
import type { Pool, PrismaClient } from "@rakazo/db";
import type { PoolClient } from "pg";
import { scheduleComputerControlExpiry } from "./computer-control.js";

const DEFAULT_INTERVAL_MS = 30_000;
const DEFAULT_BATCH_SIZE = 100;
const ROUTINE_LOOKAHEAD_MS = 60_000;
const CONTROL_LOOKAHEAD_MS = 60_000;
// Two keys give Rakazo's lock a namespace without relying on a hash that might collide
// with an application using the one-key advisory-lock API.
const RECONCILIATION_LOCK_NAMESPACE = 1_380_019_075;
const RECONCILIATION_LOCK_ID = 1;

type Cursor = { at: Date; id: string };
type ControlCursor = { at: Date | null; id: string };

export interface ReconciliationLeadership {
  tryAcquire(): Promise<boolean>;
  release(): Promise<void>;
}

/**
 * Holds a session advisory lock for the lifetime of the elected reconciler. Followers
 * retry on every reconciliation interval, so a disconnected or stopped leader is
 * replaced without coordinating through application state.
 */
export function createPostgresReconciliationLeadership(
  pool: Pick<Pool, "connect">,
  options: { lockId?: number } = {},
): ReconciliationLeadership {
  const lockId = options.lockId ?? RECONCILIATION_LOCK_ID;
  let leaderClient: PoolClient | undefined;
  let leaderErrorListener: (() => void) | undefined;

  const loseClient = (client: PoolClient) => {
    if (leaderClient !== client) return;
    leaderClient = undefined;
    leaderErrorListener = undefined;
    client.release(true);
  };

  return {
    async tryAcquire() {
      if (leaderClient) return true;

      const candidate = await pool.connect();
      try {
        const result = await candidate.query<{ acquired: boolean }>(
          "SELECT pg_try_advisory_lock($1::integer, $2::integer) AS acquired",
          [RECONCILIATION_LOCK_NAMESPACE, lockId],
        );
        if (!result.rows[0]?.acquired) {
          candidate.release();
          return false;
        }

        leaderClient = candidate;
        leaderErrorListener = () => loseClient(candidate);
        candidate.once("error", leaderErrorListener);
        return true;
      } catch (error) {
        candidate.release(true);
        throw error;
      }
    },

    async release() {
      const client = leaderClient;
      if (!client) return;
      leaderClient = undefined;
      if (leaderErrorListener) client.removeListener("error", leaderErrorListener);
      leaderErrorListener = undefined;

      let destroy = false;
      try {
        const result = await client.query<{ released: boolean }>(
          "SELECT pg_advisory_unlock($1::integer, $2::integer) AS released",
          [RECONCILIATION_LOCK_NAMESPACE, lockId],
        );
        destroy = result.rows[0]?.released !== true;
      } catch {
        // Never return a connection with an uncertain session lock to the pool.
        destroy = true;
      } finally {
        client.release(destroy);
      }
    },
  };
}

export function createJobReconciler(
  deps: {
    prisma: PrismaClient;
    jobs: JobPublisher;
    leadership?: ReconciliationLeadership;
  },
  options: { intervalMs?: number; batchSize?: number } = {},
) {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  let timer: ReturnType<typeof setInterval> | undefined;
  let reconciling: Promise<void> | undefined;
  let runCursor: Cursor | undefined;
  let routineCursor: Cursor | undefined;
  let controlCursor: ControlCursor | undefined;
  let controlScanDeadline: Date | undefined;

  const reconcileOnce = async () => {
    if (reconciling) return reconciling;
    reconciling = (async () => {
      if (deps.leadership && !(await deps.leadership.tryAcquire())) return;

      const now = new Date();
      controlScanDeadline ??= new Date(now.getTime() + CONTROL_LOOKAHEAD_MS);
      const runCursorFilter = runCursor
        ? {
            OR: [
              { updatedAt: { gt: runCursor.at } },
              { updatedAt: runCursor.at, id: { gt: runCursor.id } },
            ],
          }
        : undefined;
      const routineCursorFilter = routineCursor
        ? {
            OR: [
              { nextRunAt: { gt: routineCursor.at } },
              { nextRunAt: routineCursor.at, id: { gt: routineCursor.id } },
            ],
          }
        : undefined;
      const controlCursorFilter = controlCursor
        ? controlCursor.at
          ? {
              OR: [
                { controlLeaseExpiresAt: { gt: controlCursor.at } },
                {
                  controlLeaseExpiresAt: controlCursor.at,
                  id: { gt: controlCursor.id },
                },
                { controlLeaseExpiresAt: null },
              ],
            }
          : { controlLeaseExpiresAt: null, id: { gt: controlCursor.id } }
        : undefined;
      const [runs, routines, controls] = await Promise.all([
        deps.prisma.run.findMany({
          where: {
            AND: [
              {
                OR: [
                  { status: "queued" },
                  {
                    status: { in: ["leased", "running"] },
                    leaseExpiresAt: { lte: now },
                  },
                ],
              },
              ...(runCursorFilter ? [runCursorFilter] : []),
            ],
          },
          orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
          take: batchSize,
          select: { id: true, updatedAt: true },
        }),
        deps.prisma.routine.findMany({
          where: {
            AND: [
              {
                active: true,
                nextRunAt: { lte: new Date(now.getTime() + ROUTINE_LOOKAHEAD_MS) },
              },
              ...(routineCursorFilter ? [routineCursorFilter] : []),
            ],
          },
          orderBy: [{ nextRunAt: "asc" }, { id: "asc" }],
          take: batchSize,
          select: { id: true, nextRunAt: true },
        }),
        deps.prisma.computer.findMany({
          where: {
            AND: [
              { controlLeaseId: { not: null } },
              {
                OR: [
                  { controlLeaseExpiresAt: null },
                  {
                    controlLeaseExpiresAt: {
                      lte: controlScanDeadline,
                    },
                  },
                ],
              },
              ...(controlCursorFilter ? [controlCursorFilter] : []),
            ],
          },
          orderBy: [{ controlLeaseExpiresAt: "asc" }, { id: "asc" }],
          take: batchSize,
          select: {
            id: true,
            botId: true,
            controlLeaseId: true,
            controlLeaseExpiresAt: true,
          },
        }),
      ]);

      await Promise.all([
        ...runs.map((run) => deps.jobs.enqueue(runContinueJob(run.id))),
        ...routines.flatMap((routine) =>
          routine.nextRunAt
            ? [deps.jobs.enqueue(routineWakeupJob(routine.id, routine.nextRunAt))]
            : [],
        ),
        ...controls.map((computer) =>
          scheduleComputerControlExpiry(
            deps.jobs,
            computer.botId,
            computer.controlLeaseId!,
            computer.controlLeaseExpiresAt ?? now,
          ),
        ),
      ]);

      const lastRun = runs.at(-1);
      runCursor =
        runs.length === batchSize && lastRun
          ? { at: lastRun.updatedAt, id: lastRun.id }
          : undefined;
      const lastRoutine = routines.at(-1);
      routineCursor =
        routines.length === batchSize && lastRoutine?.nextRunAt
          ? { at: lastRoutine.nextRunAt, id: lastRoutine.id }
          : undefined;
      const lastControl = controls.at(-1);
      controlCursor =
        controls.length === batchSize && lastControl
          ? { at: lastControl.controlLeaseExpiresAt, id: lastControl.id }
          : undefined;
      if (!controlCursor) controlScanDeadline = undefined;
    })().finally(() => {
      reconciling = undefined;
    });
    return reconciling;
  };
  const reconcileSafely = () => {
    void reconcileOnce().catch((error) => console.error("background job reconciliation", error));
  };

  return {
    reconcileOnce,
    start() {
      if (timer) return;
      reconcileSafely();
      timer = setInterval(reconcileSafely, intervalMs);
      timer.unref?.();
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
      await reconciling?.catch(() => undefined);
      await deps.leadership?.release();
    },
  };
}
