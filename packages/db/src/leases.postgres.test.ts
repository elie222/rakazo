import { randomBytes } from "node:crypto";
import { deferred, flush } from "@rakazo/core/test-async";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createDb } from "./client.js";
import { assertLeaseHeld, LeaseHeldError, LeaseLostError, withLease } from "./leases.js";
import { asSystem } from "./row-security.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres = process.env.VERIFY_DATABASE && databaseUrl ? describe : describe.skip;

describePostgres("withLease (PostgreSQL)", () => {
  const prefix = `lease-test:${process.pid}-${randomBytes(3).toString("hex")}`;
  const TTL_MS = 60_000;
  let db: ReturnType<typeof createDb>;
  let sequence = 0;
  const nextKey = () => `${prefix}:${++sequence}`;

  beforeAll(() => {
    db = createDb(databaseUrl!);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  afterAll(async () => {
    if (!db) return;
    await asSystem(db.prisma).$executeRaw`DELETE FROM "leases" WHERE "key" LIKE ${`${prefix}:%`}`;
    await db.prisma.$disconnect();
    await db.pool.end();
  });

  const prisma = () => asSystem(db.prisma);

  /** Ages the lease as if its holder stopped renewing it a while ago. */
  const lapse = (key: string) =>
    prisma()
      .$executeRaw`UPDATE "leases" SET "expiresAt" = now() - interval '1 minute' WHERE "key" = ${key}`;

  const fenceOf = async (key: string) => {
    const [row] = await prisma().$queryRaw<Array<{ fence: number }>>`
      SELECT "fence" FROM "leases" WHERE "key" = ${key}`;
    return row?.fence;
  };

  /** Resolves once the lease can be taken again, waiting only on due timers, never on a clock. */
  async function untilFree(key: string) {
    for (let look = 0; look < 1_000; look++) {
      const [row] = await prisma().$queryRaw<Array<{ free: boolean }>>`
        SELECT "expiresAt" <= clock_timestamp() AS free FROM "leases" WHERE "key" = ${key}`;
      if (row?.free) return;
      await flush();
    }
    throw new Error(`lease ${key} was never released`);
  }

  const fencedWrite = (lease: { key: string; fence: number }) =>
    prisma().$transaction(async (tx) => {
      await assertLeaseHeld(tx, lease);
      return "written";
    });

  it("runs only one of two processes that contend for a key", async () => {
    const key = nextKey();
    const held = deferred();
    const started = deferred();
    const first = withLease(prisma(), key, { ttlMs: TTL_MS }, async (lease) => {
      started.resolve();
      await held.promise;
      return lease.fence;
    });
    await started.promise;

    const second = vi.fn(async () => "ran");
    await expect(withLease(prisma(), key, { ttlMs: TTL_MS }, second)).rejects.toBeInstanceOf(
      LeaseHeldError,
    );
    expect(second).not.toHaveBeenCalled();

    held.resolve();
    await expect(first).resolves.toBe(1);
  });

  it("takes each key once even when many processes race for it", async () => {
    const key = nextKey();
    const held = deferred();
    const ran: number[] = [];
    let refused = 0;
    const racers = Array.from({ length: 8 }, () =>
      withLease(prisma(), key, { ttlMs: TTL_MS }, async (lease) => {
        ran.push(lease.fence);
        await held.promise;
      }).catch((error: unknown) => {
        if (!(error instanceof LeaseHeldError)) throw error;
        refused++;
      }),
    );
    await vi.waitFor(() => expect(refused).toBe(7));
    expect(ran).toEqual([1]);
    held.resolve();
    await Promise.all(racers);
  });

  it("releases on success, failure and abort, so the next holder starts at once", async () => {
    const key = nextKey();
    await withLease(prisma(), key, { ttlMs: TTL_MS }, async () => undefined);
    await expect(
      withLease(prisma(), key, { ttlMs: TTL_MS }, async () => {
        throw new Error("work failed");
      }),
    ).rejects.toThrow("work failed");

    const abort = new AbortController();
    const started = deferred();
    const aborted = withLease(prisma(), key, { ttlMs: TTL_MS, signal: abort.signal }, (lease) => {
      started.resolve();
      return new Promise((_, reject) =>
        lease.signal.addEventListener("abort", () => reject(lease.signal.reason)),
      );
    });
    await started.promise;
    abort.abort(new Error("stopped"));
    await expect(aborted).rejects.toThrow("stopped");
    await untilFree(key);

    await expect(
      withLease(prisma(), key, { ttlMs: TTL_MS }, async (lease) => lease.fence),
    ).resolves.toBe(4);
  });

  it("keeps the lease of aborted work that ignores the signal until that work settles", async () => {
    const key = nextKey();
    const abort = new AbortController();
    const started = deferred();
    const finish = deferred();
    const aborted = withLease(prisma(), key, { ttlMs: TTL_MS, signal: abort.signal }, async () => {
      started.resolve();
      await finish.promise;
    });
    await started.promise;
    abort.abort(new Error("stopped"));
    await expect(aborted).rejects.toThrow("stopped");

    await expect(
      withLease(prisma(), key, { ttlMs: TTL_MS }, async () => undefined),
    ).rejects.toBeInstanceOf(LeaseHeldError);
    finish.resolve();
    await untilFree(key);
  });

  it("lets another process take a crashed holder's lease once it expires", async () => {
    const key = nextKey();
    const started = deferred();
    // A holder whose process died: its work never settles and nothing renews its lease.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const crashed = withLease(prisma(), key, { ttlMs: TTL_MS }, () => {
      started.resolve();
      return new Promise<never>(() => undefined);
    });
    crashed.catch(() => undefined);
    await started.promise;
    await expect(
      withLease(prisma(), key, { ttlMs: TTL_MS }, async () => undefined),
    ).rejects.toBeInstanceOf(LeaseHeldError);

    await lapse(key);

    await expect(
      withLease(prisma(), key, { ttlMs: TTL_MS }, async (lease) => lease.fence),
    ).resolves.toBe(2);
  });

  it("stops a holder that lost its lease and refuses its fenced writes", async () => {
    const key = nextKey();
    const started = deferred<{ key: string; fence: number; signal: AbortSignal }>();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const stale = withLease(prisma(), key, { ttlMs: TTL_MS }, (lease) => {
      started.resolve(lease);
      return new Promise((_, reject) =>
        lease.signal.addEventListener("abort", () => reject(lease.signal.reason)),
      );
    });
    const staleLease = await started.promise;
    await expect(fencedWrite(staleLease)).resolves.toBe("written");

    await lapse(key);
    const taken = deferred();
    const next = withLease(prisma(), key, { ttlMs: TTL_MS }, async (lease) => {
      await taken.promise;
      return lease.fence;
    });
    await vi.waitFor(async () => expect(await fenceOf(key)).toBe(2));

    await expect(fencedWrite(staleLease)).rejects.toBeInstanceOf(LeaseLostError);
    // Its next renewal finds the lease taken and stops the work.
    const stopped = expect(stale).rejects.toBeInstanceOf(LeaseLostError);
    await vi.advanceTimersByTimeAsync(TTL_MS / 5);
    await stopped;
    expect(staleLease.signal.aborted).toBe(true);

    taken.resolve();
    await expect(next).resolves.toBe(2);
  });

  it("renews the lease while work runs, and loses it when a renewal hook says so", async () => {
    const key = nextKey();
    const started = deferred();
    let keep = true;
    const onRenew = vi.fn(async () => keep);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const running = withLease(prisma(), key, { ttlMs: TTL_MS, onRenew }, (lease) => {
      started.resolve();
      return new Promise((_, reject) =>
        lease.signal.addEventListener("abort", () => reject(lease.signal.reason)),
      );
    });
    await started.promise;
    const [before] = await prisma().$queryRaw<Array<{ expiresAt: Date }>>`
      SELECT "expiresAt" FROM "leases" WHERE "key" = ${key}`;

    await vi.advanceTimersByTimeAsync(TTL_MS / 5);
    await vi.waitFor(() => expect(onRenew).toHaveBeenCalledTimes(1));
    const [after] = await prisma().$queryRaw<Array<{ expiresAt: Date }>>`
      SELECT "expiresAt" FROM "leases" WHERE "key" = ${key}`;
    expect(after!.expiresAt.getTime()).toBeGreaterThan(before!.expiresAt.getTime());

    keep = false;
    const lost = expect(running).rejects.toBeInstanceOf(LeaseLostError);
    await vi.advanceTimersByTimeAsync(TTL_MS / 5);
    await lost;
  });
});
