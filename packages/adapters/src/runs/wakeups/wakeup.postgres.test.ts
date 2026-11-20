import type {
  BackgroundJob,
  BackgroundJobHandlers,
  ManagedConnectorProvider,
} from "@rakazo/adapter-kit";
import {
  CONNECTION_CLEANUP_MAX_ATTEMPTS,
  connectionCleanupJob,
  connectionCleanupJobKey,
  lifecycleEmailJob,
  MESSAGING_SEND_MAX_ATTEMPTS,
  messagingSendJob,
  messagingSendJobKey,
  RetryJobLaterError,
  routineWakeupJob,
} from "@rakazo/adapter-kit";
import { deferred } from "@rakazo/core/test-async";
import type { PrismaClient } from "@rakazo/db";
import { asSystem, createDb, createPool, currentDbContext, runAsTenant } from "@rakazo/db";
import { createLogger, createTestSink, installLogger } from "@rakazo/logging";
import { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dropLeftoverAuthorization } from "../../integrations/connection-cleanup.js";
import {
  ABANDONED_LAST_ATTEMPT_ERROR,
  createDeadJobPruner,
  createReservedGraphileJobWorkerHost,
  GraphileJobPublisher,
  GraphileJobWorkerHost,
} from "./wakeup.js";

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

function handlers(overrides: Partial<BackgroundJobHandlers> = {}): BackgroundJobHandlers {
  return {
    "run.continue": vi.fn(async () => undefined),
    "routine.wakeup": vi.fn(async () => undefined),
    "routine.retry": vi.fn(async () => undefined),
    "computer.update": vi.fn(async () => undefined),
    "computer.sleep": vi.fn(async () => undefined),
    "computer.control-expire": vi.fn(async () => undefined),
    "skill.teaching-expire": vi.fn(async () => undefined),
    "run.forget-secrets": vi.fn(async () => undefined),
    "approval.expire": vi.fn(async () => undefined),
    "call.expire": vi.fn(async () => undefined),
    "history.compact": vi.fn(async () => undefined),
    "memory.retain-turn": vi.fn(async () => undefined),
    "memory.purge-history": vi.fn(async () => undefined),
    "messaging.send": vi.fn(async () => undefined),
    "messaging.inbound_settle": vi.fn(async () => undefined),
    "messaging.reply": vi.fn(async () => undefined),
    "messaging.deliver": vi.fn(async () => undefined),
    "messaging.progress": vi.fn(async () => undefined),
    "secret.cleanup": vi.fn(async () => undefined),
    "messaging.credential-cleanup": vi.fn(async () => undefined),
    "connection.cleanup": vi.fn(async () => undefined),
    "computer.machine-cleanup": vi.fn(async () => undefined),
    "team_chat.engage": vi.fn(async () => undefined),
    "team_chat.ambient": vi.fn(async () => undefined),
    "cloud_agent.poll": vi.fn(async () => undefined),
    "meeting.calendar-sync": vi.fn(async () => undefined),
    "meeting.work": vi.fn(async () => undefined),
    "purchase.poll": vi.fn(async () => undefined),
    "media.poll": vi.fn(async () => undefined),
    "push.receipt": vi.fn(async () => undefined),
    "email.lifecycle": vi.fn(async () => undefined),
    ...overrides,
  };
}

async function waitFor(assertion: () => void, timeoutMs = 10_000): Promise<void> {
  await vi.waitFor(assertion, { timeout: timeoutMs, interval: 25 });
}

describePostgres("Graphile background jobs (PostgreSQL contract)", () => {
  it("starts a fifth agent while four agents wait on model work", async () => {
    const publisher = new GraphileJobPublisher(testPool());
    const host = new GraphileJobWorkerHost(testPool(), { concurrency: 4, pollInterval: 25 });
    const release = deferred();
    const entered: string[] = [];
    const target = handlers({
      "run.continue": async ({ runId }, execution) => {
        entered.push(runId);
        execution!.onRunStarted();
        await release.promise;
      },
    });
    try {
      await host.start(target);
      for (let i = 0; i < 4; i++)
        await publisher.enqueue({ name: "run.continue", payload: { runId: `waiting-agent-${i}` } });
      await waitFor(() => expect(entered).toHaveLength(4));
      await publisher.enqueue({ name: "run.continue", payload: { runId: "fifth-agent" } });
      await waitFor(() => expect(entered).toContain("fifth-agent"));
      let stopped = false;
      const stopping = host.stop().then(() => {
        stopped = true;
      });
      await Promise.resolve();
      expect(stopped).toBe(false);
      release.resolve();
      await stopping;
      expect(stopped).toBe(true);
    } finally {
      release.resolve();
      await host.stop();
      await publisher.close();
    }
  });

  it("starts chat while routine and maintenance capacity are occupied", async () => {
    const prisma = {
      run: {
        findUnique: async ({ where }: { where: { id: string } }) => ({
          trigger: where.id.startsWith("routine-") ? "routine" : "user",
        }),
      },
    } as unknown as Pick<PrismaClient, "run">;
    const publisher = new GraphileJobPublisher(testPool(), prisma);
    const legacy = new GraphileJobPublisher(testPool());
    const host = createReservedGraphileJobWorkerHost(testPool(), {
      concurrency: 1,
      pollInterval: 25,
    });
    const routineEntered = deferred();
    const maintenanceEntered = deferred();
    const release = deferred();
    const received: string[] = [];
    const target = handlers({
      "run.continue": async ({ runId }) => {
        received.push(runId);
        if (runId.startsWith("routine-")) {
          routineEntered.resolve();
          await release.promise;
        }
      },
      "computer.sleep": async () => {
        maintenanceEntered.resolve();
        await release.promise;
      },
    });
    try {
      await publisher.enqueue({ name: "run.continue", payload: { runId: "routine-first" } });
      await publisher.enqueue({
        name: "computer.sleep",
        payload: { computerId: "fixture-computer" },
      });
      await host.start(target);
      await Promise.all([routineEntered.promise, maintenanceEntered.promise]);
      await publisher.enqueue({ name: "run.continue", payload: { runId: "routine-pending" } });
      await publisher.enqueue({ name: "run.continue", payload: { runId: "chat-new" } });
      // A pre-release queue entry must move even while the legacy runner is busy.
      const key = "contract:reserved:legacy";
      await legacy.enqueue({
        name: "run.continue",
        payload: { runId: "chat-legacy" },
        replaceKey: key,
      });
      await publisher.enqueue({
        name: "run.continue",
        payload: { runId: "chat-legacy" },
        replaceKey: key,
        keepExisting: true,
      });
      await waitFor(() => expect(received).toEqual(["routine-first", "chat-new", "chat-legacy"]));
      release.resolve();
      await waitFor(() => expect(received).toContain("routine-pending"));
    } finally {
      release.resolve();
      await host.stop();
      await publisher.close();
      await legacy.close();
    }
  });

  it("starts due maintenance jobs while others are still running", async () => {
    const publisher = new GraphileJobPublisher(testPool());
    const host = createReservedGraphileJobWorkerHost(testPool(), { pollInterval: 25 });
    const release = deferred();
    const sleeping: string[] = [];
    const woken: string[] = [];
    try {
      await host.start(
        handlers({
          "computer.sleep": async ({ computerId }) => {
            sleeping.push(computerId);
            await release.promise;
          },
          "routine.wakeup": async ({ routineId }) => {
            woken.push(routineId);
          },
        }),
      );
      for (const computerId of ["computer-a", "computer-b", "computer-c"]) {
        await publisher.enqueue({ name: "computer.sleep", payload: { computerId } });
      }
      await waitFor(() => expect(sleeping).toHaveLength(3));
      await publisher.enqueue(routineWakeupJob("routine-due", new Date()));
      await waitFor(() => expect(woken).toEqual(["routine-due"]));
    } finally {
      release.resolve();
      await host.stop();
      await publisher.close();
    }
  });

  it("runs outgoing message sends in parallel", async () => {
    const publisher = new GraphileJobPublisher(testPool());
    const host = createReservedGraphileJobWorkerHost(testPool(), { pollInterval: 25 });
    const release = deferred();
    const sending: string[] = [];
    try {
      await host.start(
        handlers({
          "messaging.send": async ({ outboundId }) => {
            sending.push(outboundId);
            await release.promise;
          },
        }),
      );
      await publisher.enqueue(messagingSendJob("outbound-first", new Date()));
      await waitFor(() => expect(sending).toEqual(["outbound-first"]));
      // The second send starts while the first is still sending: one slow
      // conversation must not hold back the rest. Order inside a conversation is
      // kept by the send's claim on the conversation, not by a shared queue.
      await publisher.enqueue(messagingSendJob("outbound-second", new Date()));
      await waitFor(() => expect(sending).toEqual(["outbound-first", "outbound-second"]));
      release.resolve();
    } finally {
      release.resolve();
      await host.stop();
      await publisher.close();
    }
  });

  it.each([false, true])(
    "preserves legacy retry state while routing chat (locked=%s)",
    async (locked) => {
      const prisma = { run: { findUnique: async () => ({ trigger: "user" }) } } as unknown as Pick<
        PrismaClient,
        "run"
      >;
      const publisher = new GraphileJobPublisher(testPool(), prisma);
      const legacy = new GraphileJobPublisher(testPool());
      const key = `contract:reserved:backoff:${locked}`;
      const runAt = new Date(Date.now() + 60_000);
      try {
        await legacy.enqueue({
          name: "run.continue",
          payload: { runId: "chat-backoff" },
          replaceKey: key,
          availableAt: runAt,
          maxAttempts: 5,
        });
        await testPool().query(
          "update graphile_worker._private_jobs set attempts = 2, locked_at = $2, locked_by = $3 where key = $1",
          [key, locked ? new Date() : null, locked ? "fixture-worker" : null],
        );
        const before = await keyedRow(key);
        await publisher.enqueue({
          name: "run.continue",
          payload: { runId: "chat-backoff" },
          replaceKey: key,
          keepExisting: true,
        });
        expect(await keyedRow(key)).toEqual(before);
        const { rows } = await testPool().query<{ task_identifier: string }>(
          "select task_identifier from graphile_worker.jobs where key = $1",
          [key],
        );
        expect(rows[0]?.task_identifier).toBe(locked ? "run.continue" : "run.interactive");
      } finally {
        await testPool().query(
          "update graphile_worker._private_jobs set locked_at = null, locked_by = null where key = $1",
          [key],
        );
        await publisher.cancel(key);
        await publisher.close();
        await legacy.close();
      }
    },
  );

  it("keeps a failed legacy chat delivery keyed when reconciliation promotes it", async () => {
    const prisma = {
      run: { findUnique: async () => ({ trigger: "user" }) },
    } as unknown as Pick<PrismaClient, "run">;
    const legacy = new GraphileJobPublisher(testPool());
    const publisher = new GraphileJobPublisher(testPool(), prisma);
    const host = createReservedGraphileJobWorkerHost(testPool(), {
      concurrency: 1,
      pollInterval: 25,
    });
    const key = "contract:reserved:failed-legacy";
    const runId = "failed-legacy-chat";
    const execute = vi
      .fn()
      .mockRejectedValueOnce(new Error("fixture failure before the run lease"))
      .mockResolvedValue(undefined);
    try {
      await legacy.enqueue({
        name: "run.continue",
        payload: { runId },
        replaceKey: key,
        maxAttempts: 3,
      });
      await host.start(handlers({ "run.continue": execute }));
      await waitFor(async () => {
        const { rows } = await testPool().query(
          "select attempts, locked_at, last_error from graphile_worker._private_jobs where key = $1",
          [key],
        );
        expect(rows[0]).toMatchObject({
          attempts: 1,
          locked_at: null,
          last_error: expect.any(String),
        });
      });
      await testPool().query(
        "update graphile_worker._private_jobs set run_at = now() + interval '1 hour' where key = $1",
        [key],
      );
      const before = await keyedRow(key);
      await publisher.enqueue({
        name: "run.continue",
        payload: { runId },
        replaceKey: key,
        keepExisting: true,
      });
      expect(await keyedRow(key)).toEqual(before);
      const { rows } = await testPool().query(
        "select key, task_identifier from graphile_worker.jobs where key = $1",
        [key],
      );
      expect(rows).toEqual([{ key, task_identifier: "run.interactive" }]);
      expect(execute).toHaveBeenCalledTimes(1);
      await testPool().query(
        "update graphile_worker._private_jobs set run_at = now() where key = $1",
        [key],
      );
      await waitFor(() => expect(execute).toHaveBeenCalledTimes(2));
      await waitFor(async () => expect(await keyedRow(key)).toBeNull());
    } finally {
      await host.stop();
      await publisher.cancel(key);
      await publisher.close();
      await legacy.close();
    }
  });

  it("waits for an active handler during graceful shutdown", async () => {
    const publisher = new GraphileJobPublisher(testPool());
    const host = new GraphileJobWorkerHost(testPool(), { concurrency: 1, pollInterval: 25 });
    const entered = deferred();
    const release = deferred();
    let completed = false;
    const target = handlers({
      "run.continue": async () => {
        entered.resolve();
        await release.promise;
        completed = true;
      },
    });

    try {
      await host.start(target);
      await publisher.enqueue({ name: "run.continue", payload: { runId: "graceful-stop" } });
      await entered.promise;

      let stopped = false;
      const stopping = host.stop().then(() => {
        stopped = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(stopped).toBe(false);

      release.resolve();
      await stopping;
      expect(completed).toBe(true);
      // The completion is written before stop returns, so the worker can exit right after.
      const { rowCount } = await testPool().query(
        "select 1 from graphile_worker._private_jobs where payload->>'runId' = 'graceful-stop' or payload->'payload'->>'runId' = 'graceful-stop'",
      );
      expect(rowCount).toBe(0);
    } finally {
      release.resolve();
      await host.stop();
      await publisher.close();
    }
  });

  it("hands a job still running at the drain deadline back for another worker to retry", async () => {
    const publisher = new GraphileJobPublisher(testPool());
    const host = new GraphileJobWorkerHost(testPool(), {
      concurrency: 1,
      pollInterval: 25,
      drainTimeoutMs: 200,
    });
    const entered = deferred();
    const hung = deferred();
    const target = handlers({
      "computer.sleep": async () => {
        entered.resolve();
        await hung.promise;
      },
    });
    const key = "computer.sleep:drain-deadline";

    try {
      await host.start(target);
      await publisher.enqueue({
        name: "computer.sleep",
        payload: { computerId: "drain-deadline" },
        replaceKey: key,
      });
      await entered.promise;
      await host.stop();

      const { rows } = await testPool().query<{
        locked_at: Date | null;
        last_error: string | null;
        attempts: number;
        max_attempts: number;
      }>(
        "select locked_at, last_error, attempts, max_attempts from graphile_worker._private_jobs where key = $1",
        [key],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.locked_at).toBeNull();
      expect(rows[0]!.last_error).toBeTruthy();
      expect(rows[0]!.attempts).toBeLessThan(rows[0]!.max_attempts);
    } finally {
      hung.resolve();
      await host.stop();
      await testPool().query("select graphile_worker.remove_job($1::text)", [key]);
      await publisher.close();
    }
  });

  it("runs a lifecycle mail again after it postpones itself, one at a time per person", async () => {
    const publisher = new GraphileJobPublisher(testPool());
    const host = new GraphileJobWorkerHost(testPool(), { concurrency: 4, pollInterval: 25 });
    const userId = `lifecycle-user-${Date.now()}`;
    const payload = {
      kind: "model-connection",
      organizationId: "lifecycle-organization",
      userId,
      message: { subject: "Subject", text: "Text" },
    } as const;
    const second = { ...payload, organizationId: "another-organization" };
    let running = 0;
    const overlapped: number[] = [];
    const ran: string[] = [];
    const target = handlers({
      "email.lifecycle": async ({ organizationId }) => {
        overlapped.push(++running);
        // Its first run postpones the job under its own key, as a mail inside the gap does.
        if (ran.push(organizationId) === 1)
          await publisher.enqueue(lifecycleEmailJob(payload, new Date(Date.now() + 200)));
        // A round trip gives a second runner the time to overlap if the queue let it.
        await testPool().query("select 1");
        running--;
      },
    });
    try {
      await host.start(target);
      await publisher.enqueue(lifecycleEmailJob(payload, new Date()));
      // Another of the person's mails, under its own key, shares their queue.
      await publisher.enqueue(lifecycleEmailJob(second, new Date()));
      await waitFor(() =>
        expect(ran).toEqual([
          "lifecycle-organization",
          "another-organization",
          "lifecycle-organization",
        ]),
      );
      expect(overlapped).toEqual([1, 1, 1]);
    } finally {
      await host.stop();
      await publisher.close();
    }
  });

  it("replaces a keyed delayed job without running the old payload or schedule", async () => {
    const publisher = new GraphileJobPublisher(testPool());
    const host = new GraphileJobWorkerHost(testPool(), { concurrency: 1, pollInterval: 25 });
    const received: string[] = [];
    let ranAt = 0;
    const target = handlers({
      "computer.sleep": async ({ computerId }) => {
        // Database time: the clock Graphile compares `run_at` against.
        const { rows } = await testPool().query<{ now: Date }>("select clock_timestamp() as now");
        ranAt = rows[0]!.now.getTime();
        received.push(computerId);
      },
    });
    const key = `contract:replacement:${Date.now()}`;

    try {
      await publisher.enqueue({
        name: "computer.sleep",
        payload: { computerId: "old" },
        availableAt: new Date(Date.now() + 300),
        replaceKey: key,
      });
      const deadline = new Date(Date.now() + 800);
      await publisher.enqueue({
        name: "computer.sleep",
        payload: { computerId: "replacement" },
        availableAt: deadline,
        replaceKey: key,
      });
      // The replacement must carry its own deadline, not keep the old job's:
      // a payload swap at the 300 ms schedule would run it early.
      expect((await keyedRow(key))?.runAt.getTime()).toBe(deadline.getTime());

      await host.start(target);
      // The replacement ran at its own later deadline, so the worker has polled
      // well past the old job's earlier one; the exact list proves the old
      // payload never ran.
      await waitFor(() => expect(received).toEqual(["replacement"]));
      // It ran no earlier than its own deadline, so the worker honoured the schedule.
      expect(ranAt).toBeGreaterThanOrEqual(deadline.getTime());
    } finally {
      await host.stop();
      await publisher.cancel(key).catch(() => undefined);
      await publisher.close();
    }
  });

  it("removes a keyed delayed job before a worker can run it", async () => {
    const publisher = new GraphileJobPublisher(testPool());
    const host = new GraphileJobWorkerHost(testPool(), { concurrency: 1, pollInterval: 25 });
    const target = handlers();
    const key = `contract:cancellation:${Date.now()}`;

    try {
      await host.start(target);
      await publisher.enqueue({
        name: "computer.sleep",
        payload: { computerId: "cancelled" },
        availableAt: new Date(Date.now() + 300),
        replaceKey: key,
      });
      await publisher.cancel(key);
      // A sentinel due after the cancelled job proves the worker has polled past
      // the cancelled job's deadline, so its silence is real, not a missed poll.
      await publisher.enqueue({
        name: "computer.sleep",
        payload: { computerId: "sentinel" },
        availableAt: new Date(Date.now() + 450),
      });
      const slept = () =>
        vi.mocked(target["computer.sleep"]).mock.calls.map(([{ computerId }]) => computerId);
      await waitFor(() => expect(slept()).toContain("sentinel"));
      expect(slept()).not.toContain("cancelled");
    } finally {
      await host.stop();
      await publisher.close();
    }
  });

  async function keyedRow(key: string): Promise<{
    attempts: number;
    maxAttempts: number;
    runAt: Date;
    payload: string;
  } | null> {
    const result = await testPool().query<{
      attempts: number;
      max_attempts: number;
      run_at: Date;
      payload: unknown;
    }>(
      "select attempts, max_attempts, run_at, payload from graphile_worker._private_jobs where key = $1",
      [key],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      attempts: Number(row.attempts),
      maxAttempts: Number(row.max_attempts),
      runAt: new Date(row.run_at),
      payload: JSON.stringify(row.payload),
    };
  }

  async function jobState(key: string) {
    const { rows } = await testPool().query<{
      attempts: number;
      locked_at: Date | null;
      last_error: string | null;
      run_at: Date;
    }>(
      "select attempts, locked_at, last_error, run_at from graphile_worker._private_jobs where key = $1",
      [key],
    );
    return rows[0];
  }

  it("keeps attempts and run_at while a keyed job is still in backoff", async () => {
    const publisher = new GraphileJobPublisher(testPool());
    const key = `contract:keep-backoff:${Date.now()}`;
    const runAt = new Date(Date.now() + 60 * 60 * 1000);
    try {
      await publisher.enqueue({
        name: "run.continue",
        payload: { runId: "backed-off" },
        availableAt: runAt,
        replaceKey: key,
        maxAttempts: 5,
      });
      await testPool().query(
        "update graphile_worker._private_jobs set attempts = 2, run_at = $2 where key = $1",
        [key, runAt],
      );
      await publisher.enqueue({
        name: "run.continue",
        payload: { runId: "pulled-forward" },
        availableAt: new Date(),
        replaceKey: key,
        keepExisting: true,
      });
      const kept = await keyedRow(key);
      expect(kept?.attempts).toBe(2);
      expect(kept?.maxAttempts).toBe(5);
      expect(kept?.runAt.getTime()).toBe(runAt.getTime());
      expect(kept?.payload).toContain("backed-off");
      expect(kept?.payload).not.toContain("pulled-forward");
    } finally {
      await publisher.cancel(key).catch(() => undefined);
      await publisher.close();
    }
  });

  it("re-enqueues an exhausted job with fresh attempts", async () => {
    const publisher = new GraphileJobPublisher(testPool());
    const key = `contract:keep-exhausted:${Date.now()}`;
    const revivedAt = new Date(Date.now() + 2 * 60 * 60 * 1000);
    try {
      await publisher.enqueue({
        name: "run.continue",
        payload: { runId: "exhausted" },
        availableAt: new Date(Date.now() + 60 * 60 * 1000),
        replaceKey: key,
        maxAttempts: 3,
      });
      await testPool().query(
        "update graphile_worker._private_jobs set attempts = max_attempts where key = $1",
        [key],
      );
      await publisher.enqueue({
        name: "run.continue",
        payload: { runId: "revived" },
        availableAt: revivedAt,
        replaceKey: key,
        keepExisting: true,
      });
      const revived = await keyedRow(key);
      expect(revived?.attempts).toBe(0);
      expect(revived?.runAt.getTime()).toBe(revivedAt.getTime());
      expect(revived?.payload).toContain("revived");
    } finally {
      await publisher.cancel(key).catch(() => undefined);
      await publisher.close();
    }
  });

  it("replaces a job still locked by a worker that died mid-job", async () => {
    const publisher = new GraphileJobPublisher(testPool());
    const key = `contract:keep-locked:${Date.now()}`;
    const deadWorker = `contract-dead-worker-${Date.now()}`;
    const lockedAt = new Date("2025-01-01T00:00:00.000Z");
    try {
      await publisher.enqueue({
        name: "run.continue",
        payload: { runId: "abandoned" },
        replaceKey: key,
      });
      await testPool().query(
        `update graphile_worker._private_jobs
         set attempts = 1, locked_at = $3, locked_by = $2 where key = $1`,
        [key, deadWorker, lockedAt],
      );
      await publisher.enqueue({
        name: "run.continue",
        payload: { runId: "reclaimed" },
        replaceKey: key,
        keepExisting: true,
        replaceLockedBefore: new Date(lockedAt.getTime() + 1),
      });
      const reclaimed = await keyedRow(key);
      expect(reclaimed?.attempts).toBe(0);
      expect(reclaimed?.payload).toContain("reclaimed");
      const detached = await testPool().query<{ key: string | null }>(
        "select key from graphile_worker._private_jobs where locked_by = $1",
        [deadWorker],
      );
      expect(detached.rows).toEqual([{ key: null }]);
    } finally {
      await testPool()
        .query("delete from graphile_worker._private_jobs where locked_by = $1", [deadWorker])
        .catch(() => undefined);
      await publisher.cancel(key).catch(() => undefined);
      await publisher.close();
    }
  });

  it("keeps a job locked after replaceLockedBefore", async () => {
    const publisher = new GraphileJobPublisher(testPool());
    const key = `contract:keep-live-lock:${Date.now()}`;
    const liveWorker = `contract-live-worker-${Date.now()}`;
    try {
      await publisher.enqueue({
        name: "run.continue",
        payload: { runId: "finishing" },
        replaceKey: key,
      });
      await testPool().query(
        `update graphile_worker._private_jobs
         set attempts = 1, locked_at = now(), locked_by = $2 where key = $1`,
        [key, liveWorker],
      );
      await publisher.enqueue({
        name: "run.continue",
        payload: { runId: "too-early" },
        replaceKey: key,
        keepExisting: true,
        replaceLockedBefore: new Date(Date.now() - 5 * 60_000),
      });
      const kept = await keyedRow(key);
      expect(kept?.attempts).toBe(1);
      expect(kept?.payload).toContain("finishing");
    } finally {
      await testPool()
        .query("delete from graphile_worker._private_jobs where locked_by = $1", [liveWorker])
        .catch(() => undefined);
      await publisher.cancel(key).catch(() => undefined);
      await publisher.close();
    }
  });

  it("enqueues a keepExisting job when the key is missing", async () => {
    const publisher = new GraphileJobPublisher(testPool());
    const key = `contract:keep-missing:${Date.now()}`;
    const runAt = new Date(Date.now() + 3 * 60 * 60 * 1000);
    try {
      await publisher.enqueue({
        name: "run.continue",
        payload: { runId: "fresh" },
        availableAt: runAt,
        replaceKey: key,
        keepExisting: true,
      });
      const inserted = await keyedRow(key);
      expect(inserted?.attempts).toBe(0);
      expect(inserted?.runAt.getTime()).toBe(runAt.getTime());
      expect(inserted?.payload).toContain("fresh");
    } finally {
      await publisher.cancel(key).catch(() => undefined);
      await publisher.close();
    }
  });

  // `pnpm test:integration` connects as the runtime login. graphile-worker turns on
  // row-level security for its own tables, so without the queue policy that
  // `pnpm db:migrate` installs, the runtime login can neither add nor take a job.
  it("enqueues from a request and runs the job as the restricted runtime login", async () => {
    const appPool = createPool(databaseUrl!);
    const workerPool = createPool(databaseUrl!);
    const { rows } = await appPool.query<{ restricted: boolean }>(
      `select not (r.rolsuper or r.rolbypassrls
          or pg_has_role(current_user, c.relowner, 'USAGE')) as restricted
         from pg_roles r, pg_class c
        where r.rolname = current_user and c.oid = 'graphile_worker._private_jobs'::regclass`,
    );
    expect(rows[0]?.restricted).toBe(true);
    const publisher = new GraphileJobPublisher(appPool);
    const host = new GraphileJobWorkerHost(workerPool, { concurrency: 1, pollInterval: 25 });
    const contexts: unknown[] = [];
    const key = `contract:restricted:${Date.now()}`;
    try {
      await host.start(
        handlers({
          "run.continue": async () => {
            contexts.push(currentDbContext());
          },
        }),
      );
      // The API enqueues inside the signed-in Space's context, keepExisting
      // included, which reads the queue table before adding the job.
      await runAsTenant({ spaceId: "space-restricted", userId: "user-restricted" }, () =>
        publisher.enqueue({
          name: "run.continue",
          payload: { runId: "restricted" },
          replaceKey: key,
          keepExisting: true,
        }),
      );
      await waitFor(() => expect(contexts).toHaveLength(1));
      expect(contexts[0]).toEqual({ kind: "system", reason: "background job run.continue" });
    } finally {
      await host.stop();
      await publisher.cancel(key).catch(() => undefined);
      await publisher.close();
      await appPool.end();
      await workerPool.end();
    }
  });

  it("prunes only jobs that gave up longer ago than the retention, and counts them by name", async () => {
    const publisher = new GraphileJobPublisher(testPool());
    const prefix = `contract:prune:${Date.now()}`;
    const sleep = (computerId: string) =>
      ({ name: "computer.sleep", payload: { computerId } }) as const;
    const jobs = {
      oldDead: sleep("old-dead"),
      oldDeadWake: routineWakeupJob("old-dead-wake", new Date()),
      recentDead: sleep("recent-dead"),
      // Queued long ago for a far-off time, then failed every try just now.
      queuedLongAgo: sleep("queued-long-ago"),
      lockedDead: sleep("locked-dead"),
      oldLive: sleep("old-live"),
      future: sleep("future"),
      notice: { name: "routine.retry", payload: { runId: "notice" } },
    } as const;
    const key = (name: keyof typeof jobs) => `${prefix}:${name}`;
    const keys = (Object.keys(jobs) as (keyof typeof jobs)[]).map(key);
    const sink = createTestSink();
    installLogger(createLogger({ service: "rakazo-worker", sinks: [sink] }));
    try {
      for (const [name, job] of Object.entries(jobs)) {
        await publisher.enqueue({ ...job, replaceKey: `${prefix}:${name}` } as BackgroundJob);
      }
      await testPool().query(
        `update graphile_worker._private_jobs
         set attempts = case when key = any($2::text[]) then 0 else max_attempts end,
             locked_at = case when key = $3 then now() - interval '30 days' else null end,
             locked_by = case when key = $3 then 'contract-worker' else null end,
             updated_at = case when key = $4 then now() else now() - interval '30 days' end,
             run_at = case when key = $5 then now() + interval '30 days'
                           when key = any($6::text[]) then now()
                           else now() - interval '30 days' end
         where key = any($1::text[])`,
        [
          keys,
          [key("oldLive"), key("future")],
          key("lockedDead"),
          key("recentDead"),
          key("future"),
          [key("recentDead"), key("queuedLongAgo")],
        ],
      );

      await createDeadJobPruner(testPool())();

      const remaining = await testPool().query<{ key: string }>(
        "select key from graphile_worker._private_jobs where key = any($1::text[]) order by key",
        [keys],
      );
      expect(remaining.rows.map((row) => row.key.slice(prefix.length + 1)).sort()).toEqual([
        "future",
        "lockedDead",
        "notice",
        "oldLive",
        "queuedLongAgo",
        "recentDead",
      ]);
      // Other test files share this database, so their old rows may be counted too.
      const pruned = sink.events.filter((event) => event.message === "jobs.dead_pruned");
      expect(pruned).toEqual([
        expect.objectContaining({
          level: "info",
          "jobs.removed": expect.any(Number),
          "jobs.removed_by_type": expect.stringMatching(
            /(^|,)computer\.sleep=\d+,(.*,)?routine\.wakeup=\d+(,|$)/,
          ),
        }),
      ]);
      expect(JSON.stringify(pruned)).not.toContain("old-dead");
    } finally {
      await testPool().query("delete from graphile_worker._private_jobs where key = any($1)", [
        keys,
      ]);
      await publisher.close();
      installLogger(createLogger({ service: "rakazo-worker", level: "off", sinks: [] }));
    }
  });

  it("says once that a job gave up, without its payload", async () => {
    const publisher = new GraphileJobPublisher(testPool());
    const host = new GraphileJobWorkerHost(testPool(), { concurrency: 1, pollInterval: 25 });
    const ref = `gave-up-${Date.now()}`;
    const key = `contract:gave-up:${ref}`;
    const sink = createTestSink();
    installLogger(createLogger({ service: "rakazo-worker", sinks: [sink] }));
    const gaveUp = () =>
      sink.events.filter(
        (event) => event.message === "job.gave_up" && event["job.type"] === "secret.cleanup",
      );
    const target = handlers({
      "secret.cleanup": async () => {
        throw new Error("intentional contract-test failure");
      },
    });
    const queuedAt = Date.now();
    try {
      await host.start(target);
      await publisher.enqueue({
        name: "secret.cleanup",
        payload: { kind: "secret_row", recordId: `record-${ref}`, ref },
        replaceKey: key,
        maxAttempts: 2,
      });
      await waitFor(async () =>
        expect(await jobState(key)).toMatchObject({ attempts: 1, locked_at: null }),
      );
      expect(gaveUp()).toEqual([]);
      await testPool().query(
        "update graphile_worker._private_jobs set run_at = now() where key = $1",
        [key],
      );
      await waitFor(async () =>
        expect(await jobState(key)).toMatchObject({ attempts: 2, locked_at: null }),
      );
      expect(gaveUp()).toEqual([
        expect.objectContaining({
          level: "error",
          "job.type": "secret.cleanup",
          "job.id": expect.any(String),
          "job.attempts": 2,
          "job.max_attempts": 2,
          "job.queued_ms": expect.any(Number),
          error: expect.objectContaining({ message: "intentional contract-test failure" }),
        }),
      ]);
      const [event] = gaveUp();
      expect(event!["job.queued_ms"]).toBeGreaterThanOrEqual(0);
      expect(event!["job.queued_ms"]).toBeLessThanOrEqual(Date.now() - queuedAt + 1_000);
      expect(JSON.stringify(event)).not.toContain(ref);
    } finally {
      await host.stop();
      await publisher.cancel(key).catch(() => undefined);
      await publisher.close();
      installLogger(createLogger({ service: "rakazo-worker", level: "off", sinks: [] }));
    }
  });

  it("does not say a job gave up when a later try succeeds", async () => {
    const publisher = new GraphileJobPublisher(testPool());
    const host = new GraphileJobWorkerHost(testPool(), { concurrency: 1, pollInterval: 25 });
    const ref = `recovered-${Date.now()}`;
    const key = `contract:recovered:${ref}`;
    const sink = createTestSink();
    installLogger(createLogger({ service: "rakazo-worker", sinks: [sink] }));
    let tries = 0;
    const target = handlers({
      "secret.cleanup": async () => {
        tries += 1;
        if (tries === 1) throw new Error("intentional contract-test failure");
      },
    });
    try {
      await host.start(target);
      await publisher.enqueue({
        name: "secret.cleanup",
        payload: { kind: "secret_row", recordId: `record-${ref}`, ref },
        replaceKey: key,
        maxAttempts: 2,
      });
      await waitFor(async () =>
        expect(await jobState(key)).toMatchObject({ attempts: 1, locked_at: null }),
      );
      await testPool().query(
        "update graphile_worker._private_jobs set run_at = now() where key = $1",
        [key],
      );
      await waitFor(async () => expect(await jobState(key)).toBeUndefined());
      expect(tries).toBe(2);
      expect(sink.events.filter((event) => event.message === "job.completed")).toHaveLength(2);
      expect(sink.events.filter((event) => event.message === "job.gave_up")).toEqual([]);
    } finally {
      await host.stop();
      await publisher.cancel(key).catch(() => undefined);
      await publisher.close();
      installLogger(createLogger({ service: "rakazo-worker", level: "off", sinks: [] }));
    }
  });

  it("fails and reports a last attempt whose worker died, leaving earlier attempts and live locks", async () => {
    const sink = createTestSink();
    installLogger(createLogger({ service: "rakazo-worker", sinks: [sink] }));
    const publisher = new GraphileJobPublisher(testPool());
    const prefix = `contract:abandoned:${Date.now()}`;
    const names = ["lastDead", "earlierDead", "lastLive"] as const;
    const keys = names.map((name) => `${prefix}:${name}`);
    try {
      for (const key of keys) {
        await publisher.enqueue({
          name: "computer.sleep",
          payload: { computerId: key },
          replaceKey: key,
        } as BackgroundJob);
      }
      await testPool().query(
        `update graphile_worker._private_jobs
         set attempts = case when key = $2 then 1 else max_attempts end,
             locked_by = 'contract-worker',
             locked_at = case when key = $3 then now() - interval '3 hours' else now() - interval '3 hours 55 minutes' end
         where key = any($1::text[])`,
        [keys, `${prefix}:earlierDead`, `${prefix}:lastLive`],
      );

      await createDeadJobPruner(testPool())();
      await createDeadJobPruner(testPool())();

      const rows = await testPool().query<{
        key: string;
        locked_at: Date | null;
        last_error: string | null;
      }>(
        "select key, locked_at, last_error from graphile_worker._private_jobs where key = any($1::text[])",
        [keys],
      );
      const byName = Object.fromEntries(
        rows.rows.map((row) => [row.key.slice(prefix.length + 1), row]),
      );
      expect(byName.lastDead).toMatchObject({
        locked_at: null,
        last_error: ABANDONED_LAST_ATTEMPT_ERROR,
      });
      expect(byName.earlierDead?.locked_at).not.toBeNull();
      expect(byName.lastLive?.locked_at).not.toBeNull();
      const reports = sink.events.filter((event) => event.message === "job.gave_up");
      expect(reports).toEqual([
        expect.objectContaining({
          level: "error",
          "job.type": "computer.sleep",
          "job.queue_id": expect.any(String),
          error: expect.objectContaining({ message: ABANDONED_LAST_ATTEMPT_ERROR }),
        }),
      ]);
    } finally {
      installLogger(createLogger({ service: "rakazo-worker", level: "off", sinks: [] }));
      await testPool().query("delete from graphile_worker._private_jobs where key = any($1)", [
        keys,
      ]);
      await publisher.close();
    }
  });

  it("persists a handler failure and retries the job successfully", async () => {
    const publisher = new GraphileJobPublisher(testPool());
    const host = new GraphileJobWorkerHost(testPool(), { concurrency: 1, pollInterval: 25 });
    let attempts = 0;
    const target = handlers({
      "run.continue": async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("intentional contract-test failure");
      },
    });
    const key = `contract:retry:${Date.now()}`;

    try {
      await host.start(target);
      await publisher.enqueue({
        name: "run.continue",
        payload: { runId: "retry" },
        replaceKey: key,
      });
      await waitFor(() => expect(attempts).toBe(2), 15_000);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(attempts).toBe(2);
    } finally {
      await host.stop();
      await publisher.cancel(key).catch(() => undefined);
      await publisher.close();
    }
  });

  it("adds and removes a job only when the caller's transaction commits", async () => {
    const db = createDb(databaseUrl!);
    const system = asSystem(db.prisma);
    const publisher = new GraphileJobPublisher(testPool());
    const outboundId = `contract-transaction-${Date.now()}`;
    const key = messagingSendJobKey(outboundId);
    const dueAt = new Date(Date.now() + 60 * 60 * 1000);
    const rolledBack = (work: (tx: Parameters<typeof publisher.enqueueIn>[0]) => Promise<void>) =>
      expect(
        system.$transaction(async (tx) => {
          await work(tx);
          throw new Error("fixture rollback");
        }),
      ).rejects.toThrow("fixture rollback");
    try {
      await rolledBack((tx) => publisher.enqueueIn(tx, messagingSendJob(outboundId, dueAt)));
      expect(await keyedRow(key)).toBeNull();

      // A session in another time zone still schedules the job for the same instant.
      await system.$transaction(async (tx) => {
        await tx.$executeRawUnsafe("set local time zone 'Asia/Kolkata'");
        await publisher.enqueueIn(tx, messagingSendJob(outboundId, dueAt));
      });
      expect(await keyedRow(key)).toMatchObject({
        attempts: 0,
        maxAttempts: MESSAGING_SEND_MAX_ATTEMPTS,
        runAt: dueAt,
      });

      await rolledBack((tx) => publisher.cancelIn(tx, key));
      expect(await keyedRow(key)).not.toBeNull();

      await system.$transaction((tx) => publisher.cancelIn(tx, key));
      expect(await keyedRow(key)).toBeNull();
    } finally {
      await publisher.cancel(key).catch(() => undefined);
      await publisher.close();
      await db.prisma.$disconnect();
      await db.pool.end();
    }
  });

  it("tells a handler which try of how many it is on", async () => {
    const publisher = new GraphileJobPublisher(testPool());
    const host = new GraphileJobWorkerHost(testPool(), { concurrency: 1, pollInterval: 25 });
    const outboundId = `contract-attempt-${Date.now()}`;
    const key = messagingSendJobKey(outboundId);
    const tries: unknown[] = [];
    const target = handlers({
      "messaging.send": async (_payload, _execution, attempt) => {
        tries.push(attempt);
        if (tries.length === 1) throw new Error("intentional contract-test failure");
      },
    });
    try {
      await host.start(target);
      await publisher.enqueue(messagingSendJob(outboundId, new Date()));
      await waitFor(async () =>
        expect(await jobState(key)).toMatchObject({ attempts: 1, locked_at: null }),
      );
      // Skip Graphile's backoff: only the try count is under test.
      await testPool().query(
        "update graphile_worker._private_jobs set run_at = now() where key = $1",
        [key],
      );
      await waitFor(() => expect(tries).toHaveLength(2));
      expect(tries).toEqual([
        { number: 1, max: MESSAGING_SEND_MAX_ATTEMPTS },
        { number: 2, max: MESSAGING_SEND_MAX_ATTEMPTS },
      ]);
    } finally {
      await host.stop();
      await publisher.cancel(key).catch(() => undefined);
      await publisher.close();
    }
  });

  it("retries a job that asked to wait no sooner than it asked", async () => {
    const publisher = new GraphileJobPublisher(testPool());
    const host = new GraphileJobWorkerHost(testPool(), { concurrency: 1, pollInterval: 25 });
    const outboundId = `contract-retry-later-${Date.now()}`;
    const key = messagingSendJobKey(outboundId);
    const delayMs = 10 * 60_000;
    let askedAt: Date | undefined;
    const target = handlers({
      "messaging.send": async () => {
        // Database time: the clock Graphile compares `run_at` against.
        const { rows } = await testPool().query<{ now: Date }>("select clock_timestamp() as now");
        askedAt = rows[0]!.now;
        throw new RetryJobLaterError(delayMs);
      },
    });
    try {
      await host.start(target);
      await publisher.enqueue(messagingSendJob(outboundId, new Date()));
      await waitFor(async () =>
        expect(await jobState(key)).toMatchObject({
          attempts: 1,
          locked_at: null,
          last_error: expect.any(String),
        }),
      );
      const failed = await jobState(key);
      expect(failed!.run_at.getTime()).toBeGreaterThanOrEqual(askedAt!.getTime() + delayMs);
    } finally {
      await host.stop();
      await publisher.cancel(key).catch(() => undefined);
      await publisher.close();
    }
  });

  it("logs a job that asks for a later try as a failed try, with what it waits for", async () => {
    const publisher = new GraphileJobPublisher(testPool());
    const host = new GraphileJobWorkerHost(testPool(), { concurrency: 1, pollInterval: 25 });
    const cleanup = {
      spaceId: "space-1",
      userId: "user-1",
      connectorId: "connector-1",
      provider: "mail",
      ref: `waiting-${Date.now()}`,
    };
    const key = connectionCleanupJobKey(cleanup);
    const sink = createTestSink();
    installLogger(createLogger({ service: "rakazo-worker", sinks: [sink] }));
    const target = handlers({
      // Cannot decide yet: asks for a later try, as the cleanup does for undecided accounts.
      "connection.cleanup": async () => {
        throw new RetryJobLaterError(60_000, { cause: new Error("still connecting") });
      },
    });
    const started = Date.now();
    try {
      await host.start(target);
      await publisher.enqueue(connectionCleanupJob(cleanup));
      await waitFor(async () =>
        expect(await jobState(key)).toMatchObject({ attempts: 1, locked_at: null }),
      );
      // The same record every job's retry-later gets: an error with its cause, never a quiet one.
      const completed = sink.events.filter((event) => event.message === "job.completed");
      expect(completed).toEqual([
        expect.objectContaining({
          level: "error",
          "job.type": "connection.cleanup",
          "job.outcome": "error",
          error: expect.objectContaining({
            cause: expect.objectContaining({ message: "still connecting" }),
          }),
        }),
      ]);
      expect((await jobState(key))!.run_at.getTime()).toBeGreaterThanOrEqual(started + 60_000);
    } finally {
      await host.stop();
      await publisher.cancel(key).catch(() => undefined);
      await publisher.close();
      installLogger(createLogger({ service: "rakazo-worker", level: "off", sinks: [] }));
    }
  });

  it("deletes a finished direct cleanup's job with its transaction, and leaves the job an app's cleanups share", async () => {
    const db = createDb(databaseUrl!);
    const publisher = new GraphileJobPublisher(testPool());
    const deps = { prisma: asSystem(db.prisma), jobs: publisher };
    const app = {
      spaceId: `space-${Date.now()}`,
      userId: "user-1",
      connectorId: "connector-1",
      provider: "mail",
    };
    const request = { ...app, ref: "request-1" };
    const dueAt = new Date(Date.now() + 60 * 60 * 1000);
    const direct = (connector: Record<string, unknown>, leftover: typeof app) =>
      dropLeftoverAuthorization(
        deps,
        connector as unknown as ManagedConnectorProvider,
        leftover,
        "connections.begin",
      );
    try {
      await publisher.enqueue(connectionCleanupJob(request, dueAt));
      await publisher.enqueue(connectionCleanupJob(app, dueAt));

      // A removal that fails keeps its job: the delete rolls back with the transaction.
      await expect(
        direct(
          {
            cancelAuthorizationRequest: async () => {
              throw new Error("provider unavailable");
            },
          },
          request,
        ),
      ).rejects.toThrow("provider unavailable");
      expect(await keyedRow(connectionCleanupJobKey(request))).not.toBeNull();

      const cancelAuthorizationRequest = vi.fn(async () => {
        // Still recorded while the provider is being asked.
        expect(await keyedRow(connectionCleanupJobKey(request))).not.toBeNull();
      });
      await expect(direct({ cancelAuthorizationRequest }, request)).resolves.toBe("done");
      expect(cancelAuthorizationRequest).toHaveBeenCalledTimes(1);
      expect(await keyedRow(connectionCleanupJobKey(request))).toBeNull();

      // Another begin in the scope may have recorded this job since the accounts were listed.
      const revokeUnreferencedAccounts = vi.fn(async () => undefined);
      await expect(direct({ revokeUnreferencedAccounts }, app)).resolves.toBe("done");
      expect(revokeUnreferencedAccounts).toHaveBeenCalledWith("mail", [], expect.anything());
      expect(await keyedRow(connectionCleanupJobKey(app))).toMatchObject({ runAt: dueAt });
    } finally {
      await publisher.cancel(connectionCleanupJobKey(request)).catch(() => undefined);
      await publisher.cancel(connectionCleanupJobKey(app)).catch(() => undefined);
      await publisher.close();
      await db.prisma.$disconnect();
      await db.pool.end();
    }
  });

  it("keeps a connection cleanup through a busy scope and failed tries, and reports it once it gives up", async () => {
    const publisher = new GraphileJobPublisher(testPool());
    const host = new GraphileJobWorkerHost(testPool(), { concurrency: 1, pollInterval: 25 });
    const cleanup = {
      spaceId: "space-1",
      userId: "user-1",
      connectorId: "connector-1",
      provider: "mail",
      ref: `request-${Date.now()}`,
    };
    const key = connectionCleanupJobKey(cleanup);
    const sink = createTestSink();
    installLogger(createLogger({ service: "rakazo-worker", sinks: [sink] }));
    const budget = async () => {
      const { rows } = await testPool().query<{ attempts: number; max_attempts: number }>(
        "select attempts, max_attempts from graphile_worker._private_jobs where key = $1",
        [key],
      );
      return rows[0];
    };
    let tries = 0;
    const target = handlers({
      "connection.cleanup": async (payload) => {
        tries += 1;
        // A busy scope: the job replaces itself under its key and finishes, as its handler does.
        if (tries === 1) return publisher.enqueue(connectionCleanupJob(payload, new Date()));
        throw new Error("provider unavailable");
      },
    });
    try {
      await host.start(target);
      await publisher.enqueue(connectionCleanupJob(cleanup));
      // The busy try cost nothing: the job that failed once has used one try of its full budget.
      await waitFor(async () => {
        expect(tries).toBe(2);
        expect(await budget()).toEqual({
          attempts: 1,
          max_attempts: CONNECTION_CLEANUP_MAX_ATTEMPTS,
        });
        const { rows } = await testPool().query(
          "select locked_at from graphile_worker._private_jobs where key = $1",
          [key],
        );
        expect(rows[0]?.locked_at).toBeNull();
      });

      // Skip to its last try.
      await testPool().query(
        `update graphile_worker._private_jobs set attempts = max_attempts - 1, run_at = now()
         where key = $1 and locked_at is null`,
        [key],
      );
      await waitFor(() =>
        expect(
          sink.events.filter((event) => event.message.startsWith("connection cleanup gave up")),
        ).toEqual([
          expect.objectContaining({
            level: "error",
            connectorId: "connector-1",
            provider: "mail",
            providerRef: cleanup.ref,
          }),
        ]),
      );
      expect(tries).toBe(3);
      // The exhausted job keeps its payload until the dead-job retention passes.
      expect(await budget()).toEqual({
        attempts: CONNECTION_CLEANUP_MAX_ATTEMPTS,
        max_attempts: CONNECTION_CLEANUP_MAX_ATTEMPTS,
      });
    } finally {
      await host.stop();
      await publisher.cancel(key).catch(() => undefined);
      await publisher.close();
    }
  });
});
