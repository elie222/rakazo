import type { BackgroundJob } from "@rakazo/adapter-kit";
import { SecretNotFoundError } from "@rakazo/adapter-kit";
import type { Prisma } from "@rakazo/db";
import { createLogger, createTestSink, installLogger } from "@rakazo/logging";
import { describe, expect, it, vi } from "vitest";
import type { SecretCleanup, SecretCleanupDeps } from "./secret-cleanup.js";
import {
  attemptSecretCleanup,
  cleanUpUnsavedSecret,
  finishSecretCleanup,
  recordSecretCleanup,
  retrySecretCleanup,
  savedSecretIn,
  secretCleanupJob,
  secretCleanupJobKey,
} from "./secret-cleanup.js";
import holderColumns from "./secret-holder-columns.json" with { type: "json" };

const REF = "remote:entry-1";
const cleanup: SecretCleanup = { kind: "secret_row", recordId: "secret-a", ref: REF };

const SECRET_TABLES = [
  "secret",
  "botSecret",
  "vaultCredential",
  "integrationProviderConfig",
] as const;
const anyRow: SecretCleanup = { kind: "secret_tables", recordId: "secret-a", ref: REF };

/** Each kind of record holds `held`; `remote` is whether the store keeps values elsewhere. */
function fixture(held: string | null = null, remote = true) {
  const row = (column: string) => vi.fn(async () => (held === null ? null : { [column]: held }));
  /** How many of a table's rows hold the reference asked about. */
  const count = () => vi.fn(async (_args: { where: Record<string, unknown> }) => 0);
  /** A purchase or the deployment holds `held` in whichever of its sealed columns is read. */
  const purchase = vi.fn(async ({ select }: { select: Record<string, boolean> }) =>
    held === null ? null : Object.fromEntries(Object.keys(select).map((column) => [column, held])),
  );
  const prisma = {
    secret: { findUnique: row("ciphertext"), count: count() },
    botSecret: { count: count() },
    vaultCredential: { count: count() },
    integrationProviderConfig: { count: count() },
    messagingInstallation: { findUnique: row("ciphertext") },
    deploymentSettings: { findUnique: purchase },
    purchase: { findUnique: purchase },
    paymentWallet: { findUnique: row("ciphertext") },
    /** Whether any holder column has the reference, as a written entry's backup asks. */
    $queryRaw: vi.fn(async (_query: Prisma.Sql) => [{ held: false }]),
  };
  const queued = new Map<string, BackgroundJob>();
  const queue = async (job: BackgroundJob) => {
    queued.set(job.replaceKey ?? "", job);
  };
  const secrets = {
    delete: vi.fn(async (_ref: string, _context: unknown) => undefined),
    isRemote: () => remote,
  };
  const jobs = {
    enqueue: vi.fn(queue),
    enqueueIn: vi.fn((_tx: unknown, job: BackgroundJob) => queue(job)),
    enqueueManyIn: vi.fn(async (_tx: unknown, jobs: readonly BackgroundJob[]) => {
      for (const job of jobs) await queue(job);
    }),
    cancel: vi.fn(async (key: string) => {
      queued.delete(key);
    }),
    cancelIn: vi.fn(async (_tx: unknown, key: string) => {
      queued.delete(key);
    }),
  };
  const deps = { prisma, secrets, jobs } as unknown as SecretCleanupDeps;
  return { deps, prisma, secrets, jobs, queued };
}

const tx = { $executeRawUnsafe: async () => undefined };

describe("secret cleanup", () => {
  it("keys the job by a digest, so a retry replaces its backup without naming the reference", () => {
    const backup = secretCleanupJob(cleanup, new Date(60_000));
    const retry = secretCleanupJob(cleanup);
    expect(backup).toMatchObject({ name: "secret.cleanup", payload: cleanup, maxAttempts: 20 });
    expect(retry).not.toHaveProperty("availableAt");
    expect(retry.replaceKey).toBe(backup.replaceKey);
    expect(backup.replaceKey).not.toContain(REF);
    expect(secretCleanupJobKey("remote:entry-2")).not.toBe(backup.replaceKey);
  });

  it("records a backup with the transaction, deletes the entry, then deletes the backup", async () => {
    const f = fixture();
    await recordSecretCleanup(f.deps, tx, cleanup);
    expect(f.jobs.enqueueIn).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ payload: cleanup, availableAt: expect.any(Date) }),
    );
    expect(f.queued.size).toBe(1);
    await finishSecretCleanup(f.deps, cleanup);
    expect(f.secrets.delete).toHaveBeenCalledWith(
      REF,
      expect.objectContaining({ recordId: "secret-a", signal: expect.any(AbortSignal) }),
    );
    expect(f.queued.size).toBe(0);
  });

  it("hands a failed delete to the job to run now, without rejecting", async () => {
    const f = fixture();
    await recordSecretCleanup(f.deps, tx, cleanup);
    f.secrets.delete.mockRejectedValueOnce(new Error("secret store unavailable"));
    await expect(finishSecretCleanup(f.deps, cleanup)).resolves.toBeUndefined();
    expect(f.jobs.cancel).not.toHaveBeenCalled();
    expect([...f.queued.values()]).toEqual([secretCleanupJob(cleanup)]);
  });

  it("keeps the backup of a reference other rows still hold, since another drop may own it", async () => {
    const f = fixture();
    f.prisma.secret.count.mockResolvedValue(1);
    await recordSecretCleanup(f.deps, tx, anyRow);
    await finishSecretCleanup(f.deps, anyRow);
    expect(f.secrets.delete).not.toHaveBeenCalled();
    expect(f.jobs.cancel).not.toHaveBeenCalled();
    expect(f.queued.size).toBe(1);
  });

  it("stops at an entry the store refuses under this record, instead of retrying the refusal", async () => {
    const f = fixture();
    await recordSecretCleanup(f.deps, tx, cleanup);
    f.secrets.delete.mockRejectedValue(new SecretNotFoundError());
    await finishSecretCleanup(f.deps, cleanup);
    expect(f.jobs.enqueue).not.toHaveBeenCalled();
    expect(f.queued.size).toBe(0);
    await expect(retrySecretCleanup(f.deps, cleanup)).resolves.toBeUndefined();
  });

  it("leaves a one-shot attempt's failure to its caller, saying nothing about a retry", async () => {
    const sink = createTestSink();
    installLogger(createLogger({ service: "test", sinks: [sink] }));
    try {
      const f = fixture();
      f.secrets.delete.mockRejectedValue(new Error("secret store unavailable"));
      await expect(attemptSecretCleanup(f.deps, cleanup)).rejects.toThrow("unavailable");
      expect(sink.events).toEqual([]);
      await expect(retrySecretCleanup(f.deps, cleanup)).rejects.toThrow("unavailable");
      expect(sink.events.map((event) => event.message)).toEqual(["secret cleanup retry failed"]);
    } finally {
      installLogger(createLogger({ service: "test", level: "off", sinks: [] }));
    }
  });

  it("still does not reject when the queue is unreachable too", async () => {
    const f = fixture();
    f.secrets.delete.mockRejectedValueOnce(new Error("secret store unavailable"));
    f.jobs.enqueue.mockRejectedValue(new Error("database unavailable"));
    await expect(cleanUpUnsavedSecret(f.deps, cleanup)).resolves.toBeUndefined();
    f.jobs.cancel.mockRejectedValueOnce(new Error("database unavailable"));
    await expect(finishSecretCleanup(f.deps, cleanup)).resolves.toBeUndefined();
  });

  it("records the backup before deleting a secret no transaction saved", async () => {
    const f = fixture();
    await cleanUpUnsavedSecret(f.deps, cleanup);
    expect(f.jobs.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ payload: cleanup, availableAt: expect.any(Date) }),
    );
    expect(f.jobs.enqueue.mock.invocationCallOrder[0]).toBeLessThan(
      f.secrets.delete.mock.invocationCallOrder[0]!,
    );
    expect(f.queued.size).toBe(0);
  });

  it("never copies an inline reference, which is the sealed value, into a job", async () => {
    const f = fixture(null, false);
    await recordSecretCleanup(f.deps, tx, cleanup);
    await finishSecretCleanup(f.deps, cleanup);
    await cleanUpUnsavedSecret(f.deps, cleanup);
    f.secrets.delete.mockRejectedValueOnce(new Error("notification failed"));
    await expect(finishSecretCleanup(f.deps, cleanup)).resolves.toBeUndefined();
    expect(f.secrets.delete).toHaveBeenCalledWith(REF, "secret-a");
    expect(f.jobs.enqueue).not.toHaveBeenCalled();
    expect(f.jobs.enqueueIn).not.toHaveBeenCalled();
  });

  it.each([
    ["secret_row", "secret-a", "secret", { id: "secret-a" }, "ciphertext"],
    [
      "messaging_installation",
      "install-a",
      "messagingInstallation",
      { id: "install-a" },
      "ciphertext",
    ],
    [
      "deployment_computer_provider",
      "deployment",
      "deploymentSettings",
      { id: "default" },
      "computerProviderCipher",
    ],
    [
      "deployment_model",
      "deployment-model",
      "deploymentSettings",
      { id: "default" },
      "deploymentModelCredentialCipher",
    ],
    [
      "purchase_request",
      "purchase-request:op-1",
      "purchase",
      { operationKey: "op-1" },
      "requestCiphertext",
    ],
    [
      "purchase_card",
      "purchase-card:purchase-1",
      "purchase",
      { id: "purchase-1" },
      "cardCiphertext",
    ],
    [
      "purchase_token",
      "purchase-token:purchase-1",
      "purchase",
      { id: "purchase-1" },
      "tokenCiphertext",
    ],
    [
      "payment_wallet",
      "payment-wallet:user-1",
      "paymentWallet",
      { userId: "user-1" },
      "ciphertext",
    ],
  ] as const)(
    "spares a %s reference that is in use again",
    async (kind, recordId, table, where, column) => {
      const inUse = fixture(REF);
      await retrySecretCleanup(inUse.deps, { kind, recordId, ref: REF });
      expect(inUse.prisma[table].findUnique).toHaveBeenCalledWith({
        where,
        select: { [column]: true },
      });
      expect(inUse.secrets.delete).not.toHaveBeenCalled();
      await finishSecretCleanup(inUse.deps, { kind, recordId, ref: REF });
      expect(inUse.secrets.delete).not.toHaveBeenCalled();

      for (const held of ["remote:entry-2", null]) {
        const replaced = fixture(held);
        await retrySecretCleanup(replaced.deps, { kind, recordId, ref: REF });
        expect(replaced.secrets.delete).toHaveBeenCalledWith(
          REF,
          expect.objectContaining({ recordId }),
        );
      }
    },
  );

  it.each(SECRET_TABLES)(
    "spares a reference a %s row holds, whichever row dropped it",
    async (table) => {
      const f = fixture();
      f.prisma[table].count.mockResolvedValue(1);
      await retrySecretCleanup(f.deps, anyRow);
      await finishSecretCleanup(f.deps, anyRow);
      expect(f.prisma[table].count).toHaveBeenCalledWith({ where: { ciphertext: REF } });
      expect(f.secrets.delete).not.toHaveBeenCalled();
    },
  );

  it("deletes a reference only after counting every secret table", async () => {
    const f = fixture();
    await retrySecretCleanup(f.deps, anyRow);
    for (const table of SECRET_TABLES)
      expect(f.prisma[table].count).toHaveBeenCalledWith({ where: { ciphertext: REF } });
    expect(f.secrets.delete).toHaveBeenCalledWith(
      REF,
      expect.objectContaining({ recordId: "secret-a" }),
    );
    f.prisma.integrationProviderConfig.count.mockRejectedValueOnce(
      new Error("database unavailable"),
    );
    await expect(retrySecretCleanup(f.deps, anyRow)).rejects.toThrow("database unavailable");
    expect(f.secrets.delete).toHaveBeenCalledTimes(1);
  });

  it("leaves a failed retry to the queue's own retries", async () => {
    const f = fixture();
    f.secrets.delete.mockRejectedValueOnce(new Error("secret store unavailable"));
    await expect(retrySecretCleanup(f.deps, cleanup)).rejects.toThrow("secret store unavailable");
    f.prisma.secret.findUnique.mockRejectedValueOnce(new Error("database unavailable"));
    await expect(retrySecretCleanup(f.deps, cleanup)).rejects.toThrow("database unavailable");
    expect(f.secrets.delete).toHaveBeenCalledTimes(1);
  });

  const written: SecretCleanup = { kind: "store_write", recordId: "store-record", ref: REF };

  it("keeps a written entry a holder column has when its backup runs", async () => {
    const f = fixture();
    f.prisma.$queryRaw.mockResolvedValue([{ held: true }]);
    await retrySecretCleanup(f.deps, written);
    expect(f.secrets.delete).not.toHaveBeenCalled();
  });

  it("deletes a written entry only after one lookup of every checked column", async () => {
    const f = fixture();
    await retrySecretCleanup(f.deps, written);
    expect(f.prisma.$queryRaw).toHaveBeenCalledOnce();
    const query = f.prisma.$queryRaw.mock.calls[0]![0];
    const looked = [...query.sql.matchAll(/FROM "(\w+)" WHERE "(\w+)" = \?/g)].map(
      ([, table, column]) => `${table}.${column}`,
    );
    expect(looked).toEqual(holderColumns.checked);
    expect(query.values).toEqual(holderColumns.checked.map(() => REF));
    expect(f.secrets.delete).toHaveBeenCalledWith(
      REF,
      expect.objectContaining({ recordId: "store-record" }),
    );
  });

  it("removes a saved entry's write-ahead job in the save's transaction, and none for an inline reference", async () => {
    const f = fixture();
    await savedSecretIn(f.deps, tx, REF);
    expect(f.jobs.cancelIn).toHaveBeenCalledWith(tx, secretCleanupJobKey(REF));
    expect(f.jobs.cancel).not.toHaveBeenCalled();
    const inline = fixture(null, false);
    await savedSecretIn(inline.deps, tx, REF);
    expect(inline.jobs.cancelIn).not.toHaveBeenCalled();
  });
});
