import type { BackgroundJob } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import type { SecretCleanup, SecretCleanupDeps } from "./secret-cleanup.js";
import {
  cleanUpUnsavedSecret,
  finishSecretCleanup,
  recordSecretCleanup,
  retrySecretCleanup,
  secretCleanupJob,
  secretCleanupJobKey,
} from "./secret-cleanup.js";

const REF = "remote:entry-1";
const cleanup: SecretCleanup = { kind: "secret_row", recordId: "secret-a", ref: REF };

/** Each kind of record holds `held`; `remote` is whether the store keeps values elsewhere. */
function fixture(held: string | null = null, remote = true) {
  const row = (column: string) => vi.fn(async () => (held === null ? null : { [column]: held }));
  /** A purchase holds `held` in whichever of its sealed columns is read. */
  const purchase = vi.fn(async ({ select }: { select: Record<string, boolean> }) =>
    held === null ? null : Object.fromEntries(Object.keys(select).map((column) => [column, held])),
  );
  const prisma = {
    secret: { findUnique: row("ciphertext") },
    messagingInstallation: { findUnique: row("ciphertext") },
    deploymentSettings: { findUnique: row("computerProviderCipher") },
    purchase: { findUnique: purchase },
    paymentWallet: { findUnique: row("ciphertext") },
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
    cancel: vi.fn(async (key: string) => {
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

  it("leaves a failed retry to the queue's own retries", async () => {
    const f = fixture();
    f.secrets.delete.mockRejectedValueOnce(new Error("secret store unavailable"));
    await expect(retrySecretCleanup(f.deps, cleanup)).rejects.toThrow("secret store unavailable");
    f.prisma.secret.findUnique.mockRejectedValueOnce(new Error("database unavailable"));
    await expect(retrySecretCleanup(f.deps, cleanup)).rejects.toThrow("database unavailable");
    expect(f.secrets.delete).toHaveBeenCalledTimes(1);
  });
});
