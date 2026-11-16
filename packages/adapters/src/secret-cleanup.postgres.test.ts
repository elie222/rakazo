import { asSystem, createDb, Prisma, runAsSystem } from "@rakazo/db";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createBackgroundJobHandlers } from "./background-job-handlers.js";
import type { SecretCleanup } from "./secret-cleanup.js";
import { finishSecretCleanup, recordSecretCleanup, secretCleanupJobKey } from "./secret-cleanup.js";
import { GraphileJobPublisher } from "./wakeup.js";

// Needs DATABASE_URL as the runtime login and DATABASE_MIGRATION_URL as the owner,
// as `pnpm test:integration` provides.
const runtimeUrl = process.env.DATABASE_URL;
const migrationUrl = process.env.DATABASE_MIGRATION_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && runtimeUrl && migrationUrl && runtimeUrl !== migrationUrl
    ? describe
    : describe.skip;

describePostgres("secret cleanup (PostgreSQL)", () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const userId = `secret-cleanup-user-${suffix}`;
  const cleanup: SecretCleanup = {
    kind: "secret_row",
    recordId: `secret-cleanup-row-${suffix}`,
    ref: `remote:secret-cleanup-${suffix}`,
  };
  const key = secretCleanupJobKey(cleanup.ref);
  const store = {
    delete: vi.fn(async (_ref: string, _context: unknown) => undefined),
    isRemote: () => true,
  };
  let owner: ReturnType<typeof createDb>;
  let db: ReturnType<typeof createDb>;
  let pool: Pool;
  let jobs: GraphileJobPublisher;

  const saveRow = () =>
    asSystem(owner.prisma).secret.create({
      data: { id: cleanup.recordId, userId, kind: "computer-provider", ciphertext: cleanup.ref },
    });
  /** The transaction that stops referring to the secret, as a settings save runs it. */
  const dropRow = (fail?: Error) =>
    runAsSystem("test fixture", () =>
      db.prisma.$transaction(
        async (tx) => {
          await tx.secret.deleteMany({ where: { id: cleanup.recordId } });
          await recordSecretCleanup({ secrets: store, jobs }, tx, cleanup);
          if (fail) throw fail;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      ),
    );
  const queued = async () =>
    (
      await pool.query<{ due: boolean; payload: { payload?: unknown } }>(
        "select run_at <= now() as due, payload from graphile_worker._private_jobs where key = $1",
        [key],
      )
    ).rows;

  beforeAll(async () => {
    owner = createDb(migrationUrl!);
    db = createDb(runtimeUrl!);
    pool = new Pool({ connectionString: runtimeUrl, max: 2 });
    jobs = new GraphileJobPublisher(pool);
    await asSystem(owner.prisma).user.create({
      data: { id: userId, name: "Cleanup", email: `${userId}@rakazo.test`, emailVerified: true },
    });
  });

  afterAll(async () => {
    if (!owner) return;
    await jobs.cancel(key);
    await asSystem(owner.prisma).user.deleteMany({ where: { id: userId } });
    await jobs.close();
    await pool.end();
    for (const handle of [owner, db]) {
      await handle.prisma.$disconnect();
      await handle.pool.end();
    }
  });

  it("commits the backup with the write, retries a failed delete, and spares a reference in use again", async () => {
    const deps = { prisma: db.prisma, secrets: store, jobs };
    const handlers = createBackgroundJobHandlers({
      prisma: db.prisma,
      secretStore: store,
    } as unknown as Parameters<typeof createBackgroundJobHandlers>[0]);
    const runJob = () =>
      runAsSystem("background job secret.cleanup", () => handlers["secret.cleanup"](cleanup));

    await saveRow();
    await expect(dropRow(new Error("rolled back"))).rejects.toThrow("rolled back");
    expect(await queued()).toEqual([]);

    await dropRow();
    const [backup] = await queued();
    expect(backup).toMatchObject({ due: false });
    expect(JSON.stringify(backup?.payload)).toContain(cleanup.ref);

    store.delete.mockRejectedValueOnce(new Error("secret store unavailable"));
    await finishSecretCleanup(deps, cleanup);
    expect(await queued()).toMatchObject([{ due: true }]);

    await saveRow();
    store.delete.mockClear();
    await runJob();
    expect(store.delete).not.toHaveBeenCalled();

    await asSystem(owner.prisma).secret.deleteMany({ where: { id: cleanup.recordId } });
    await runJob();
    expect(store.delete).toHaveBeenCalledWith(
      cleanup.ref,
      expect.objectContaining({ recordId: cleanup.recordId }),
    );

    await finishSecretCleanup(deps, cleanup);
    expect(await queued()).toEqual([]);
  });
});
