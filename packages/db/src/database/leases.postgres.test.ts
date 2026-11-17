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
    const [row] = await prisma().$queryRaw<Array<{ fence: bigint }>>`
      SELECT "fence" FROM "leases" WHERE "key" = ${key}`;
    return row && Number(row.fence);
  };

  /** Resolves once the lease can be taken again, waiting only on due timers, never on a clock. */
  async function untilFree(key: string) {
    for (let look = 0; look < 1_000; look++) {
      const [row] = await prisma().$queryRaw<Array<{ free: boolean }>>`
        SELECT NOT EXISTS (
          SELECT 1 FROM "leases" WHERE "key" = ${key} AND "expiresAt" > clock_timestamp()
        ) AS free`;
      if (row?.free) return;
      await flush();
    }
    throw new Error(`lease ${key} was never released`);
  }

  /** `prisma()`, passing each lease query to `intercept` first, which may hold it. */
  const intercepting = (intercept: (sql: string) => Promise<void> | void) => {
    const client = prisma();
    return new Proxy(client, {
      get(target, name, receiver) {
        if (name !== "$queryRaw") return Reflect.get(target, name, receiver);
        return async (strings: TemplateStringsArray, ...values: unknown[]) => {
          await intercept(strings.join("?"));
          return target.$queryRaw(strings, ...values);
        };
      },
    });
  };

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
    await expect(first).resolves.toEqual(expect.any(Number));
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
    expect(ran).toHaveLength(1);
    held.resolve();
    await Promise.all(racers);
  });

  it("releases on success, failure and abort, so the next holder starts at once", async () => {
    const key = nextKey();
    const first = await withLease(prisma(), key, { ttlMs: TTL_MS }, async (lease) => lease.fence);
    await expect(fenceOf(key)).resolves.toBeUndefined();
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
    ).resolves.toBeGreaterThan(first);
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
    const crashedFence = await fenceOf(key);
    await expect(
      withLease(prisma(), key, { ttlMs: TTL_MS }, async () => undefined),
    ).rejects.toBeInstanceOf(LeaseHeldError);

    await lapse(key);

    await expect(
      withLease(prisma(), key, { ttlMs: TTL_MS }, async (lease) => lease.fence),
    ).resolves.toBeGreaterThan(crashedFence!);
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
    await vi.waitFor(async () => expect(await fenceOf(key)).toBeGreaterThan(staleLease.fence));

    await expect(fencedWrite(staleLease)).rejects.toBeInstanceOf(LeaseLostError);
    // Its next renewal finds the lease taken and stops the work.
    const stopped = expect(stale).rejects.toBeInstanceOf(LeaseLostError);
    await vi.advanceTimersByTimeAsync(TTL_MS / 5);
    await stopped;
    expect(staleLease.signal.aborted).toBe(true);

    taken.resolve();
    await expect(next).resolves.toBeGreaterThan(staleLease.fence);
  });

  it("refuses a stale holder's fenced write after a later holder released the key", async () => {
    const key = nextKey();
    const started = deferred<{ key: string; fence: number }>();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const stale = withLease(prisma(), key, { ttlMs: TTL_MS }, (lease) => {
      started.resolve(lease);
      return new Promise<never>(() => undefined);
    });
    stale.catch(() => undefined);
    const staleLease = await started.promise;
    await lapse(key);

    await withLease(prisma(), key, { ttlMs: TTL_MS }, async () => undefined);
    await expect(fenceOf(key)).resolves.toBeUndefined();
    const latest = await withLease(prisma(), key, { ttlMs: TTL_MS }, async (lease) => {
      await expect(fencedWrite(staleLease)).rejects.toBeInstanceOf(LeaseLostError);
      return lease.fence;
    });
    expect(latest).toBeGreaterThan(staleLease.fence);
  });

  it("starts no work when the caller aborts while the lease is being taken", async () => {
    const key = nextKey();
    const taking = deferred();
    const proceed = deferred();
    const client = intercepting(async (sql) => {
      if (!sql.includes("INSERT INTO")) return;
      taking.resolve();
      await proceed.promise;
    });
    const abort = new AbortController();
    const work = vi.fn(async () => "ran");
    const running = withLease(client, key, { ttlMs: TTL_MS, signal: abort.signal }, work);
    await taking.promise;
    abort.abort(new Error("stopped"));
    proceed.resolve();

    await expect(running).rejects.toThrow("stopped");
    expect(work).not.toHaveBeenCalled();
    await expect(fenceOf(key)).resolves.toBeUndefined();
  });

  it("counts the lease's lifetime from when the take lands, not from when it was sent", async () => {
    const key = nextKey();
    const taking = deferred();
    const proceed = deferred();
    const client = intercepting(async (sql) => {
      if (!sql.includes("INSERT INTO")) return;
      taking.resolve();
      await proceed.promise;
    });
    const started = deferred<AbortSignal>();
    const onRenew = vi.fn(async () => true);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const running = withLease(client, key, { ttlMs: TTL_MS, onRenew }, (lease) => {
      started.resolve(lease.signal);
      return new Promise((_, reject) =>
        lease.signal.addEventListener("abort", () => reject(lease.signal.reason)),
      );
    });
    running.catch(() => undefined);
    await taking.promise;
    // The take waits most of a TTL behind another transaction, then lands with a full one.
    vi.setSystemTime(Date.now() + TTL_MS * 0.9);
    proceed.resolve();
    const signal = await started.promise;

    await vi.advanceTimersByTimeAsync(TTL_MS / 5);
    await vi.waitFor(() => expect(onRenew).toHaveBeenCalledTimes(1));
    expect(signal.aborted).toBe(false);
  });

  it("starts no work when the lease lapsed before a slow take was confirmed", async () => {
    const key = nextKey();
    const taking = deferred();
    const proceed = deferred();
    const client = intercepting(async (sql) => {
      if (sql.includes("INSERT INTO")) {
        taking.resolve();
        await proceed.promise;
      } else if (sql.trimStart().startsWith("UPDATE")) {
        // The answer to the take arrived after the lease it made had already lapsed.
        await lapse(key);
      }
    });
    const work = vi.fn(async () => undefined);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const running = withLease(client, key, { ttlMs: TTL_MS }, work);
    running.catch(() => undefined);
    await taking.promise;
    vi.setSystemTime(Date.now() + TTL_MS * 1.5);
    proceed.resolve();
    await expect(running).rejects.toBeInstanceOf(LeaseLostError);
    expect(work).not.toHaveBeenCalled();
  });

  it("gives a slow take back when confirming it fails", async () => {
    const key = nextKey();
    const taking = deferred();
    const proceed = deferred();
    const client = intercepting(async (sql) => {
      if (sql.includes("INSERT INTO")) {
        taking.resolve();
        await proceed.promise;
      } else if (sql.trimStart().startsWith("UPDATE")) {
        throw new Error("database unavailable");
      }
    });
    const work = vi.fn(async () => undefined);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const running = withLease(client, key, { ttlMs: TTL_MS }, work);
    running.catch(() => undefined);
    await taking.promise;
    vi.setSystemTime(Date.now() + TTL_MS * 0.5);
    proceed.resolve();
    await expect(running).rejects.toThrow("database unavailable");
    expect(work).not.toHaveBeenCalled();
    vi.useRealTimers();
    expect(await fenceOf(key)).toBeUndefined();
  });

  it("stops renewing only once a renewal in flight lands, and runs no hook after the work", async () => {
    const key = nextKey();
    const renewing = deferred();
    const proceed = deferred();
    const released = vi.fn();
    const client = intercepting(async (sql) => {
      if (sql.includes("DELETE FROM") || sql.includes("'epoch'")) released();
      else if (!sql.trimStart().startsWith("UPDATE")) return;
      else {
        renewing.resolve();
        await proceed.promise;
      }
    });
    const onRenew = vi.fn(async () => true);
    const started = deferred();
    const fail = deferred();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let settled = false;
    const running = withLease(client, key, { ttlMs: TTL_MS, onRenew }, () => {
      started.resolve();
      return fail.promise;
    });
    running.then(
      () => (settled = true),
      () => (settled = true),
    );
    await started.promise;
    await vi.advanceTimersByTimeAsync(TTL_MS / 5);
    await renewing.promise;

    fail.reject(new Error("work failed"));
    // Stopping takes only promise callbacks, so had it not waited it would have released by now.
    await new Promise(setImmediate);
    expect(settled).toBe(false);
    expect(released).not.toHaveBeenCalled();

    proceed.resolve();
    await expect(running).rejects.toThrow("work failed");
    expect(released).toHaveBeenCalledTimes(1);
    expect(onRenew).not.toHaveBeenCalled();
    await expect(fenceOf(key)).resolves.toBeUndefined();
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
      UPDATE "leases" SET "expiresAt" = "expiresAt" - interval '1 second' WHERE "key" = ${key}
      RETURNING "expiresAt"`;

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
