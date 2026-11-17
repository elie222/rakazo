import { randomUUID } from "node:crypto";
import type {
  PaymentWalletConnectResult,
  PaymentWalletCredential,
  PaymentWalletProvider,
  SecretStore,
} from "@rakazo/adapter-kit";
import { asSystem, createDb, runAsSystem, runAsTenant } from "@rakazo/db";
import { Pool } from "pg";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createBackgroundJobHandlers } from "./background-job-handlers.js";
import type { PaymentWalletDeps } from "./payment-wallets.js";
import {
  connectPaymentWallet,
  disconnectPaymentWallet,
  paymentWalletConnected,
  paymentWalletStatus,
  withPaymentWalletCredential,
} from "./payment-wallets.js";
import type { SecretCleanup } from "./secret-cleanup.js";
import { secretCleanupJobKey } from "./secret-cleanup.js";
import { fakeCleanupJobs } from "./secret-cleanup.test-support.js";
import { EncryptedSecretStore } from "./secrets.js";
import { GraphileJobPublisher } from "./wakeup.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres = process.env.VERIFY_DATABASE && databaseUrl ? describe : describe.skip;

/** A wallet whose sign-in completes at once with a credential already due for refresh. */
function testWallet(): PaymentWalletProvider & { refresh: ReturnType<typeof vi.fn> } {
  return {
    displayName: "Test Wallet",
    describe: () => ({
      id: "test-wallet",
      contractVersion: "1",
      adapterVersion: "0",
      capabilities: { offline: true, credentials: ["card"] },
    }),
    beginConnect: async () => ({
      state: "device-state",
      verificationUrl: "https://wallet.example.test/verify",
      userCode: "ABCD-EFGH",
      expiresAt: new Date(Date.now() + 15 * 60_000),
      intervalMs: 1_000,
    }),
    pollConnect: async (): Promise<PaymentWalletConnectResult> => ({
      status: "connected",
      credential: { secret: "credential-0", refreshAt: new Date(Date.now() - 1_000) },
    }),
    refresh: vi.fn(async (credential: PaymentWalletCredential) => {
      // Long enough for concurrent callers to queue on the lock.
      await new Promise((resolve) => setTimeout(resolve, 100));
      return { secret: `${credential.secret}-next`, refreshAt: new Date(Date.now() + 3_600_000) };
    }),
    disconnect: async () => undefined,
    createPurchase: async () => {
      throw new Error("unused");
    },
    getPurchase: async () => {
      throw new Error("unused");
    },
    revealCard: async () => {
      throw new Error("unused");
    },
    revealPayToken: async () => {
      throw new Error("unused");
    },
    readHttpPaymentChallenge: async () => null,
    authorizeHttpPayment: async () => {
      throw new Error("unused");
    },
  };
}

describePostgres("payment wallets (PostgreSQL contract)", () => {
  const db = databaseUrl ? createDb(databaseUrl, { poolMax: 6 }) : undefined;
  const users: string[] = [];
  const secretStore = new EncryptedSecretStore("test-only-encryption-key");

  afterAll(async () => {
    if (!db) return;
    const prisma = asSystem(db.prisma);
    await prisma.organization.deleteMany({ where: { id: { in: users } } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
    await db.prisma.$disconnect();
    await db.pool.end();
  });

  async function seedUser() {
    const prisma = asSystem(db!.prisma);
    const id = randomUUID();
    users.push(id);
    await prisma.user.create({
      data: { id, name: "Wallet test", email: `${id}@example.test`, emailVerified: true },
    });
    await prisma.organization.create({
      data: { id, name: "Wallet test", slug: id, createdAt: new Date() },
    });
    await prisma.space.create({
      data: { id, organizationId: id, name: "Wallet test", isDefault: true },
    });
    return { userId: id, spaceId: id };
  }

  it("connects, keeps the wallet to its user, and refreshes a rotating credential once", async () => {
    const actor = await seedUser();
    const other = await seedUser();
    const provider = testWallet();
    const deps: PaymentWalletDeps = {
      prisma: db!.prisma,
      secretStore,
      jobs: fakeCleanupJobs().jobs,
      paymentWallet: provider,
    };

    await runAsTenant(actor, () => connectPaymentWallet(deps, actor));
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    expect(await runAsTenant(actor, () => paymentWalletStatus(deps, actor))).toMatchObject({
      status: "connected",
    });
    expect(await runAsTenant(other, () => paymentWalletConnected(deps, actor.userId))).toBe(false);

    const seen = await Promise.all(
      Array.from({ length: 4 }, () =>
        runAsTenant(actor, () =>
          withPaymentWalletCredential(deps, actor, async (credential) => credential.secret),
        ),
      ),
    );
    expect(provider.refresh).toHaveBeenCalledTimes(1);
    expect(new Set(seen)).toEqual(new Set(["credential-0-next"]));
    const row = await asSystem(db!.prisma).paymentWallet.findUniqueOrThrow({
      where: { userId: actor.userId },
    });
    expect(row.ciphertext).not.toContain("credential");
    expect(row.refreshAt!.getTime()).toBeGreaterThan(Date.now());
  });

  it("commits a forgotten credential's cleanup with the disconnect and deletes it from the job", async () => {
    const actor = await seedUser();
    const pool = new Pool({ connectionString: databaseUrl, max: 2 });
    const queue = new GraphileJobPublisher(pool);
    const remove = vi.fn(async (_ref: string, _context: unknown) => undefined);
    // A store that keeps credentials elsewhere, so each one must be deleted there.
    const remote = {
      put: secretStore.put.bind(secretStore),
      load: secretStore.load.bind(secretStore),
      delete: remove,
      isRemote: () => true,
    } as unknown as SecretStore;
    const deps: PaymentWalletDeps = {
      prisma: db!.prisma,
      secretStore: remote,
      // The direct attempt cannot hand over, as when the process stops right after the commit.
      jobs: {
        enqueueIn: (tx, job) => queue.enqueueIn(tx, job),
        enqueue: async () => undefined,
        cancel: (key) => queue.cancel(key),
        cancelIn: (tx, key) => queue.cancelIn(tx, key),
      },
      paymentWallet: testWallet(),
    };
    let key: string | undefined;
    try {
      await runAsTenant(actor, () => connectPaymentWallet(deps, actor));
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      await runAsTenant(actor, () => paymentWalletStatus(deps, actor));
      const { ciphertext } = await asSystem(db!.prisma).paymentWallet.findUniqueOrThrow({
        where: { userId: actor.userId },
      });
      const cleanup: SecretCleanup = {
        kind: "payment_wallet",
        recordId: `payment-wallet:${actor.userId}`,
        ref: ciphertext,
      };
      key = secretCleanupJobKey(ciphertext);
      const queued = async () =>
        (
          await pool.query<{ due: boolean }>(
            "select run_at <= now() as due from graphile_worker._private_jobs where key = $1",
            [key],
          )
        ).rows;
      const handlers = createBackgroundJobHandlers({
        prisma: db!.prisma,
        secretStore: remote,
      } as unknown as Parameters<typeof createBackgroundJobHandlers>[0]);
      const runJob = () =>
        runAsSystem("background job secret.cleanup", () => handlers["secret.cleanup"](cleanup));

      // While the wallet holds the credential, neither a job nor a late retry touches it.
      expect(await queued()).toEqual([]);
      remove.mockClear();
      await runJob();
      expect(remove).not.toHaveBeenCalled();

      remove.mockRejectedValueOnce(new Error("secret store unavailable"));
      await runAsTenant(actor, () => disconnectPaymentWallet(deps, actor));
      expect(await queued()).toEqual([{ due: false }]);
      await runJob();
      expect(remove).toHaveBeenLastCalledWith(
        ciphertext,
        expect.objectContaining({ recordId: cleanup.recordId }),
      );
    } finally {
      if (key) await queue.cancel(key);
      await queue.close();
      await pool.end();
    }
  });
});
