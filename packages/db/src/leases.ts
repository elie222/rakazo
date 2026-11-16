import { abortableDelay, anySignal, requestDeadline, retry, withAbort } from "@rakazo/core";
import { bestEffort, getLogger } from "@rakazo/logging";
import type { Prisma, PrismaClient } from "./client.js";

type LeaseQueries = Pick<PrismaClient | Prisma.TransactionClient, "$queryRaw">;

export type HeldLease = {
  readonly key: string;
  /** Grows with every holder of the key. Pass the lease to `assertLeaseHeld` to guard a write. */
  readonly fence: number;
  /** Aborts once the lease is lost, a renewal cannot land in time, or the caller's signal aborts. */
  readonly signal: AbortSignal;
};

export type LeaseOptions = {
  /** How long the lease outlives its last renewal. It is renewed every fifth of this. */
  ttlMs: number;
  signal?: AbortSignal;
  /** Runs after each renewal; false or a failure that outlasts the lease loses it. */
  onRenew?: () => Promise<boolean>;
};

export class LeaseHeldError extends Error {
  override readonly name = "LeaseHeldError";
  constructor(readonly key: string) {
    super(`Another process holds the lease on ${key}`);
  }
}

export class LeaseLostError extends Error {
  override readonly name = "LeaseLostError";
  constructor(
    readonly key: string,
    options?: { cause?: unknown },
  ) {
    super(`Lost the lease on ${key}`, options);
  }
}

/**
 * Runs `work` while this process alone holds `key`, or throws `LeaseHeldError` at once. The lease
 * is renewed while the work runs; once it is lost or the caller's signal aborts, `lease.signal`
 * aborts and this rejects with its reason without waiting for the work. The lease is released
 * when the work settles, so the next holder can start at once; work that never settles leaves it
 * to lapse after `ttlMs`, when another process may take it.
 */
export async function withLease<T>(
  prisma: PrismaClient,
  key: string,
  options: LeaseOptions,
  work: (lease: HeldLease) => Promise<T>,
): Promise<T> {
  options.signal?.throwIfAborted();
  const takenAt = Date.now();
  const fence = await takeLease(prisma, key, options.ttlMs);
  if (fence === undefined) throw new LeaseHeldError(key);
  const lost = new AbortController();
  const stopRenewing = new AbortController();
  const signal = options.signal ? anySignal([options.signal, lost.signal]) : lost.signal;
  const renewing = keepRenewed(prisma, key, fence, options, takenAt, lost, stopRenewing.signal);
  const running = Promise.resolve().then(() => work({ key, fence, signal }));
  let settled = false;
  const released = running
    .then(
      () => undefined,
      () => undefined,
    )
    .then(async () => {
      settled = true;
      stopRenewing.abort();
      await renewing;
      await bestEffort(`release lease ${key}`, releaseLease(prisma, key, fence));
    });
  try {
    return await withAbort(running, signal);
  } finally {
    stopRenewing.abort();
    if (settled || !signal.aborted) await released;
  }
}

/**
 * Locks the lease row until the transaction ends, so no other process takes it before the
 * transaction's writes commit. Throws `LeaseLostError` once another holder has it or it lapsed.
 */
export async function assertLeaseHeld(
  tx: Prisma.TransactionClient,
  lease: Pick<HeldLease, "key" | "fence">,
): Promise<void> {
  const rows = await tx.$queryRaw<unknown[]>`
    SELECT 1 FROM "leases"
    WHERE "key" = ${lease.key} AND "fence" = ${lease.fence} AND "expiresAt" > clock_timestamp()
    FOR SHARE`;
  if (rows.length === 0) throw new LeaseLostError(lease.key);
}

async function takeLease(
  prisma: LeaseQueries,
  key: string,
  ttlMs: number,
): Promise<number | undefined> {
  const rows = await prisma.$queryRaw<Array<{ fence: number }>>`
    INSERT INTO "leases" ("key", "fence", "expiresAt")
    VALUES (${key}, 1, clock_timestamp() + ${ttlMs}::float8 * interval '1 millisecond')
    ON CONFLICT ("key") DO UPDATE
      SET "fence" = "leases"."fence" + 1, "expiresAt" = EXCLUDED."expiresAt"
      WHERE "leases"."expiresAt" <= clock_timestamp()
    RETURNING "fence"`;
  return rows[0]?.fence;
}

async function renewLease(
  prisma: LeaseQueries,
  key: string,
  fence: number,
  ttlMs: number,
): Promise<boolean> {
  const rows = await prisma.$queryRaw<unknown[]>`
    UPDATE "leases"
    SET "expiresAt" = clock_timestamp() + ${ttlMs}::float8 * interval '1 millisecond'
    WHERE "key" = ${key} AND "fence" = ${fence} AND "expiresAt" > clock_timestamp()
    RETURNING 1`;
  return rows.length > 0;
}

async function releaseLease(prisma: LeaseQueries, key: string, fence: number): Promise<void> {
  await prisma.$queryRaw`
    UPDATE "leases" SET "expiresAt" = 'epoch'::timestamptz
    WHERE "key" = ${key} AND "fence" = ${fence}
    RETURNING 1`;
}

/**
 * Renews until stopped. A renewal that fails is retried until the lease would lapse; the holder
 * counts it lost a renewal interval before the database would, so it stops before another may start.
 */
async function keepRenewed(
  prisma: LeaseQueries,
  key: string,
  fence: number,
  options: LeaseOptions,
  takenAt: number,
  lost: AbortController,
  stop: AbortSignal,
): Promise<void> {
  const everyMs = options.ttlMs / 5;
  let keptUntil = takenAt + options.ttlMs - everyMs;
  const renew = async () =>
    (await renewLease(prisma, key, fence, options.ttlMs)) && (await (options.onRenew?.() ?? true));
  for (;;) {
    await abortableDelay(everyMs, stop);
    if (stop.aborted) return;
    const sentAt = Date.now();
    const deadline = requestDeadline(
      Math.max(0, keptUntil - sentAt),
      `Lost the lease on ${key}`,
      stop,
    );
    try {
      const renewed = await withAbort(
        retry(renew, {
          attempts: Number.POSITIVE_INFINITY,
          retryable: () => !deadline.signal.aborted,
          signal: deadline.signal,
          onRetry: (error) => getLogger().warn("lease renewal failed", { key, error }),
        }),
        deadline.signal,
      );
      if (stop.aborted) return;
      if (!renewed) {
        lost.abort(new LeaseLostError(key));
        return;
      }
      keptUntil = sentAt + options.ttlMs - everyMs;
    } catch (error) {
      if (stop.aborted) return;
      lost.abort(new LeaseLostError(key, { cause: error }));
      return;
    } finally {
      deadline.dispose();
    }
  }
}
