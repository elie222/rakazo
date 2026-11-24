import { Pool } from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { GraphileJobPublisher } from "./wakeup.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres = process.env.VERIFY_DATABASE && databaseUrl ? describe : describe.skip;

let pool: Pool | undefined;
function testPool(): Pool {
  pool ??= new Pool({ connectionString: databaseUrl, max: 4 });
  return pool;
}
afterEach(async () => {
  await pool?.end();
  pool = undefined;
});

describePostgres("Graphile named-queue order (PostgreSQL contract)", () => {
  it("says when the last unfinished job of a named queue is due, a replaced one in its place", async () => {
    const publisher = new GraphileJobPublisher(testPool());
    const suffix = `${process.pid}-${Date.now()}`;
    const queueName = `contract:pending-until:${suffix}`;
    const job = (key: string, runAt: Date, queue = queueName) => ({
      name: "history.compact" as const,
      payload: { threadId: key },
      availableAt: runAt,
      replaceKey: `${queue}:${key}`,
      queueName: queue,
      maxAttempts: 3,
    });
    const soon = new Date(Date.now() + 60 * 60 * 1000);
    const later = new Date(Date.now() + 2 * 60 * 60 * 1000);
    const elsewhere = new Date(Date.now() + 3 * 60 * 60 * 1000);
    const keys = [`${queueName}:soon`, `${queueName}:later`, `${queueName}-other:other`];
    const none = { until: null, own: false };
    try {
      expect(await publisher.pendingUntil(queueName)).toEqual(none);
      await publisher.enqueue(job("soon", soon));
      await publisher.enqueue(job("later", later));
      await publisher.enqueue(job("other", elsewhere, `${queueName}-other`));
      expect(await publisher.pendingUntil(queueName)).toEqual({ until: later, own: false });
      // With a job's key, only the jobs queued ahead of it count, as for its redelivery, and the
      // answer says whether it is queued itself.
      expect(await publisher.pendingUntil(queueName, keys[1])).toEqual({ until: soon, own: true });
      expect(await publisher.pendingUntil(queueName, keys[0])).toEqual({ until: null, own: true });
      expect(await publisher.pendingUntil(queueName, `${queueName}:missing`)).toEqual({
        until: later,
        own: false,
      });
      // A job written again under its key, in a transaction or not, keeps its id and so its place:
      // due after the job recorded behind it, it still counts as ahead of that one.
      const tx = {
        $executeRawUnsafe: (query: string, ...values: unknown[]) => testPool().query(query, values),
      };
      const idOf = "select id from graphile_worker._private_jobs where key = $1";
      const first = (await testPool().query(idOf, [keys[0]])).rows[0];
      const late = new Date(later.getTime() + 60_000);
      await publisher.enqueueIn(tx, job("soon", late));
      expect(await publisher.pendingUntil(queueName, keys[1])).toEqual({ until: late, own: true });
      await publisher.enqueue(job("soon", soon));
      expect((await testPool().query(idOf, [keys[0]])).rows[0]).toEqual(first);

      // A job that used up its tries is finished, though its row stays.
      await testPool().query(
        "update graphile_worker._private_jobs set attempts = max_attempts where key = $1",
        [keys[1]],
      );
      expect(await publisher.pendingUntil(queueName)).toEqual({ until: soon, own: false });
      // One on its last try while a worker holds it is not.
      await testPool().query(
        "update graphile_worker._private_jobs set attempts = max_attempts, locked_at = now(), locked_by = 'contract' where key = $1",
        [keys[1]],
      );
      expect(await publisher.pendingUntil(queueName)).toEqual({ until: later, own: false });

      await publisher.cancel(keys[0]!);
      await testPool().query("delete from graphile_worker._private_jobs where key = $1", [keys[1]]);
      expect(await publisher.pendingUntil(queueName)).toEqual(none);
    } finally {
      await testPool().query("delete from graphile_worker._private_jobs where key = any($1)", [
        keys,
      ]);
      await publisher.close();
    }
  });

  it("makes the followers at the head of a named queue due now, in their order", async () => {
    const publisher = new GraphileJobPublisher(testPool());
    const queueName = `contract:followers:${process.pid}-${Date.now()}`;
    const hour = 60 * 60 * 1000;
    const base = Date.now() + hour;
    const job = (name: string, runAt: number, follower: boolean, queue = queueName) => ({
      name: "messaging.inbound_settle" as const,
      payload: {
        provider: "contract",
        handle: `${queue}:${name}`,
        identityId: "contract",
        spaceId: "contract",
        botId: "contract",
        receivedAt: 0,
        text: "",
        attachments: [],
        ...(follower ? { follower: true } : {}),
      },
      availableAt: new Date(runAt),
      replaceKey: `${queue}:${name}`,
      queueName: queue,
      maxAttempts: 3,
    });
    const jobs = [
      // The one settling, then two that wait only for it, then one still downloading elsewhere
      // and the follower behind that.
      job("settling", base, false),
      job("first", base + 1, true),
      job("second", base + 2, true),
      job("downloading", base + hour, false),
      job("behind", base + hour + 1, true),
      job("elsewhere", base + 1, true, `${queueName}-other`),
    ];
    const runAt = async (key: string) =>
      (
        await testPool().query<{ run_at: Date }>(
          "select run_at from graphile_worker._private_jobs where key = $1",
          [key],
        )
      ).rows[0]!.run_at.getTime();
    const tx = {
      $executeRawUnsafe: (query: string, ...values: unknown[]) => testPool().query(query, values),
    };
    try {
      for (const queued of jobs) await publisher.enqueue(queued);
      // Held, so no worker of another suite takes a job made due here.
      await testPool().query(
        "update graphile_worker._private_job_queues set locked_at = now(), locked_by = 'contract' where queue_name = any($1)",
        [[queueName, `${queueName}-other`]],
      );
      const before = Date.now();
      await publisher.releaseFollowersIn(tx, queueName, jobs[0]!.replaceKey);
      const after = Date.now();
      const first = await runAt(jobs[1]!.replaceKey);
      expect(first).toBeGreaterThanOrEqual(before - 1_000);
      expect(first).toBeLessThanOrEqual(after);
      expect(await runAt(jobs[2]!.replaceKey)).toBe(first + 1);
      expect(await runAt(jobs[0]!.replaceKey)).toBe(base);
      expect(await runAt(jobs[3]!.replaceKey)).toBe(base + hour);
      expect(await runAt(jobs[4]!.replaceKey)).toBe(base + hour + 1);
      expect(await runAt(jobs[5]!.replaceKey)).toBe(base + 1);

      // A job running at the head holds its followers until it settles and releases them.
      await testPool().query(
        "update graphile_worker._private_jobs set locked_at = now(), locked_by = 'contract' where key = $1",
        [jobs[3]!.replaceKey],
      );
      await publisher.releaseFollowersIn(tx, queueName);
      expect(await runAt(jobs[4]!.replaceKey)).toBe(base + hour + 1);
    } finally {
      await testPool().query("delete from graphile_worker._private_jobs where key = any($1)", [
        jobs.map((queued) => queued.replaceKey),
      ]);
      await publisher.close();
    }
  });
});
