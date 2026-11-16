import type { JobPublisher, SecretStore } from "@rakazo/adapter-kit";
import { dispatchBackgroundJob } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { asSystem, createDb, runAsSystem, runAsTenant } from "@rakazo/db";
import { unwrapJobPayload } from "@rakazo/logging";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createBackgroundJobHandlers } from "./background-job-handlers.js";
import { secretCleanupJobKey } from "./secret-cleanup.js";
import { withSecretPersistence } from "./secret-persistence.js";
import { GraphileJobPublisher } from "./wakeup.js";

// Needs DATABASE_URL as the runtime login and DATABASE_MIGRATION_URL as the owner,
// as `pnpm test:integration` provides.
const runtimeUrl = process.env.DATABASE_URL;
const migrationUrl = process.env.DATABASE_MIGRATION_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && runtimeUrl && migrationUrl && runtimeUrl !== migrationUrl
    ? describe
    : describe.skip;

describePostgres("secret persistence cleanup (PostgreSQL)", () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const userId = `secret-persistence-user-${suffix}`;
  const otherUserId = `secret-persistence-other-${suffix}`;
  const refs: string[] = [];
  /** The remote store: the entries it still keeps, and whether it answers. */
  const entries = new Set<string>();
  let reachable = true;
  const store = {
    delete: vi.fn(async (ref: string, _context: unknown) => {
      if (!reachable) throw new Error("secret store unavailable");
      entries.delete(ref);
    }),
    isRemote: () => true,
  };
  let owner: ReturnType<typeof createDb>;
  let db: ReturnType<typeof createDb>;
  let pool: Pool;
  let jobs: GraphileJobPublisher;
  let prisma: PrismaClient;
  let handlers: ReturnType<typeof createBackgroundJobHandlers>;

  /** A new entry in the store, not yet held by any row. */
  const entry = (name: string) => {
    const ref = `remote:${name}-${suffix}`;
    refs.push(ref);
    entries.add(ref);
    return ref;
  };
  const secretRow = (id: string, ciphertext: string, holder = userId) =>
    asSystem(owner.prisma).secret.create({
      data: { id: `${id}-${suffix}`, userId: holder, kind: "computer-provider", ciphertext },
    });
  /** As a request from the user, who sees their own account secrets and no one else's. */
  const asUser = <T>(work: () => Promise<T>) =>
    runAsTenant({ spaceId: `no-space-${suffix}`, userId }, work);
  const asApp = <T>(work: () => Promise<T>) => runAsSystem("test fixture", work);
  const queued = async (ref: string) =>
    (
      await pool.query<{ due: boolean; payload: unknown }>(
        "select run_at <= now() as due, payload from graphile_worker._private_jobs where key = $1",
        [secretCleanupJobKey(ref)],
      )
    ).rows;
  /** Runs the queued cleanup from what the queue stored, as a worker does when it is due. */
  const runQueued = async (ref: string) => {
    const [job] = await queued(ref);
    expect(job).toBeDefined();
    await runAsSystem("background job secret.cleanup", () =>
      dispatchBackgroundJob(handlers, "secret.cleanup", unwrapJobPayload(job!.payload).payload),
    );
  };

  beforeAll(async () => {
    owner = createDb(migrationUrl!);
    db = createDb(runtimeUrl!);
    pool = new Pool({ connectionString: runtimeUrl, max: 2 });
    jobs = new GraphileJobPublisher(pool);
    prisma = withSecretPersistence(db.prisma, store as unknown as SecretStore, () => jobs);
    handlers = createBackgroundJobHandlers({
      prisma: db.prisma,
      secretStore: store,
    } as unknown as Parameters<typeof createBackgroundJobHandlers>[0]);
    for (const id of [userId, otherUserId])
      await asSystem(owner.prisma).user.create({
        data: { id, name: "Cleanup", email: `${id}@rakazo.test`, emailVerified: true },
      });
  });

  beforeEach(() => {
    reachable = true;
    store.delete.mockClear();
  });

  afterAll(async () => {
    if (!owner) return;
    for (const ref of refs) await jobs.cancel(secretCleanupJobKey(ref));
    await asSystem(owner.prisma).user.deleteMany({ where: { id: { in: [userId, otherUserId] } } });
    await asSystem(owner.prisma).integrationProviderConfig.deleteMany({
      where: { id: { endsWith: suffix } },
    });
    await jobs.close();
    await pool.end();
    for (const handle of [owner, db]) {
      await handle.prisma.$disconnect();
      await handle.pool.end();
    }
  });

  it("retries removing a replaced entry once the store is back", async () => {
    const [old, next] = [entry("replaced"), entry("replacement")];
    const row = await secretRow("replace", old);

    reachable = false;
    await asUser(() => prisma.secret.update({ where: { id: row.id }, data: { ciphertext: next } }));
    expect(entries.has(old)).toBe(true);
    const [retry] = await queued(old);
    expect(retry).toMatchObject({ due: true });
    expect(unwrapJobPayload(retry!.payload).payload).toEqual({
      kind: "secret_tables",
      recordId: row.id,
      ref: old,
    });
    expect(await queued(next)).toEqual([]);

    reachable = true;
    await runQueued(old);
    expect(entries.has(old)).toBe(false);
    expect(entries.has(next)).toBe(true);
  });

  it("removes the entry and its backup at once while the store answers", async () => {
    const ref = entry("removed");
    const row = await secretRow("remove", ref);
    await asUser(() => prisma.secret.deleteMany({ where: { id: row.id } }));
    expect(entries.has(ref)).toBe(false);
    expect(await queued(ref)).toEqual([]);
  });

  it("commits the backup with the write, so it runs when nothing after the commit does", async () => {
    const ref = entry("crashed");
    const row = await secretRow("crash", ref);
    // After the commit this process reaches neither the store nor the queue, as when it dies.
    const dying: Pick<JobPublisher, "enqueue" | "enqueueIn" | "cancel"> = {
      enqueueIn: (tx, job) => jobs.enqueueIn(tx, job),
      enqueue: async () => {
        throw new Error("process gone");
      },
      cancel: async () => {
        throw new Error("process gone");
      },
    };
    const crashing = withSecretPersistence(db.prisma, store as unknown as SecretStore, () => dying);

    reachable = false;
    await expect(
      asApp(() =>
        crashing.$transaction(async (tx) => {
          await tx.secret.deleteMany({ where: { id: row.id } });
          throw new Error("rolled back");
        }),
      ),
    ).rejects.toThrow("rolled back");
    expect(await queued(ref)).toEqual([]);

    await asApp(() => crashing.secret.deleteMany({ where: { id: row.id } }));
    expect(entries.has(ref)).toBe(true);
    expect(await queued(ref)).toMatchObject([{ due: false }]);

    reachable = true;
    await runQueued(ref);
    expect(entries.has(ref)).toBe(false);
  });

  it("never removes an entry another row still holds, also when the job runs later", async () => {
    const shared = entry("shared");
    const first = await secretRow("shared-a", shared);
    const second = await secretRow("shared-b", shared, otherUserId);
    const vault = await asSystem(owner.prisma).vaultCredential.create({
      data: {
        id: `shared-vault-${suffix}`,
        userId,
        name: `shared-${suffix}`,
        origin: "https://example.test",
        auth: {},
        ciphertext: shared,
      },
    });
    const config = await asSystem(owner.prisma).integrationProviderConfig.create({
      data: { id: `shared-config-${suffix}`, ciphertext: shared },
    });

    // The first drop is the user's own request, which cannot see the other user's row.
    const drops = [
      () => asUser(() => prisma.secret.deleteMany({ where: { id: first.id } })),
      () => asApp(() => prisma.secret.deleteMany({ where: { id: second.id } })),
      () => asApp(() => prisma.vaultCredential.deleteMany({ where: { id: vault.id } })),
    ];
    for (const drop of drops) {
      await drop();
      expect(await asSystem(owner.prisma).secret.count({ where: { id: first.id } })).toBe(0);
      expect(store.delete).not.toHaveBeenCalled();
      await runQueued(shared);
      expect(store.delete).not.toHaveBeenCalled();
      expect(entries.has(shared)).toBe(true);
    }

    await asApp(() => prisma.integrationProviderConfig.deleteMany({ where: { id: config.id } }));
    expect(store.delete).toHaveBeenCalledWith(
      shared,
      expect.objectContaining({ recordId: `integration-provider:${config.id}` }),
    );
    expect(entries.has(shared)).toBe(false);
    expect(await queued(shared)).toEqual([]);
  });
});
