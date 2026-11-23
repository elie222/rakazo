import type {
  PaymentWalletConnectResult,
  PaymentWalletCredential,
  PaymentWalletProvider,
  SecretStore,
} from "@rakazo/adapter-kit";
import { PaymentWalletDisconnected } from "@rakazo/adapter-kit";
import { deferred } from "@rakazo/core/test-async";
import type { PaymentWallet, PrismaClient } from "@rakazo/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeCleanupJobs } from "../secrets/secret-cleanup.test-support.js";
import type { PaymentWalletDeps } from "./payment-wallets.js";
import {
  connectPaymentWallet,
  disconnectPaymentWallet,
  paymentWalletConnected,
  paymentWalletStatus,
  withPaymentWalletCredential,
} from "./payment-wallets.js";

const actor = { userId: "user-1", spaceId: "space-1" };
const NOW = new Date("2026-10-27T12:00:00.000Z");

type Row = PaymentWallet;

function fakePrisma() {
  const rows: Row[] = [];
  let sequence = 0;
  const matches = (row: Row, where: Record<string, unknown>) =>
    Object.entries(where).every(([key, value]) => {
      const actual = row[key as keyof Row];
      if (value instanceof Date)
        return actual instanceof Date && actual.getTime() === value.getTime();
      return actual === value;
    });
  const paymentWallet = {
    findUnique: vi.fn(async ({ where }: { where: { userId: string } }) => {
      const row = rows.find((entry) => entry.userId === where.userId);
      return row ? { ...row } : null;
    }),
    updateMany: vi.fn(
      async ({ where, data }: { where: Record<string, unknown>; data: Partial<Row> }) => {
        const found = rows.filter((row) => matches(row, where));
        for (const row of found) Object.assign(row, data, { updatedAt: new Date() });
        return { count: found.length };
      },
    ),
    update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
      const row = rows.find((entry) => entry.id === where.id);
      if (!row) throw new Error("not found");
      Object.assign(row, data, { updatedAt: new Date() });
      return { ...row };
    }),
    deleteMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
      const before = rows.length;
      for (let index = rows.length - 1; index >= 0; index -= 1)
        if (matches(rows[index]!, where)) rows.splice(index, 1);
      return { count: before - rows.length };
    }),
    upsert: vi.fn(
      async ({
        where,
        create,
        update,
      }: {
        where: { userId: string };
        create: Partial<Row>;
        update: Partial<Row>;
      }) => {
        const row = rows.find((entry) => entry.userId === where.userId);
        if (row) {
          Object.assign(row, update, { updatedAt: new Date() });
          return { ...row };
        }
        sequence += 1;
        const created = {
          id: `wallet-${sequence}`,
          verificationUrl: null,
          userCode: null,
          expiresAt: null,
          nextPollAt: null,
          pollIntervalMs: null,
          refreshAt: null,
          connectedAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...create,
        } as Row;
        rows.push(created);
        return { ...created };
      },
    ),
  };
  let lostAfterCommit: Error | undefined;
  const prisma = {
    paymentWallet,
    $executeRaw: vi.fn(async () => 1),
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => {
      const result = await fn(prisma);
      if (lostAfterCommit) throw lostAfterCommit;
      return result;
    }),
  };
  /** Every later transaction commits, but its caller never learns it did. */
  const loseProcessAfterCommit = () => {
    lostAfterCommit = new Error("process lost after commit");
  };
  return { prisma, rows, loseProcessAfterCommit };
}

function fakeSecrets(remote: boolean) {
  const values = new Map<string, string>();
  let sequence = 0;
  const store = {
    put: vi.fn(async (plaintext: string, _context: unknown, options?: { recordId?: string }) => {
      sequence += 1;
      const ref = `ref-${sequence}`;
      values.set(ref, plaintext);
      return { id: options?.recordId ?? ref, ref, ciphertext: ref };
    }),
    load: vi.fn(async (ref: string) => {
      const value = values.get(ref);
      if (value === undefined) throw new Error("missing");
      return value;
    }),
    delete: vi.fn(async (ref: string, _context?: unknown) => {
      values.delete(ref);
    }),
    isRemote: () => remote,
  };
  return { store, values };
}

function fakeProvider(id = "fake") {
  const provider = {
    displayName: "Fake Wallet",
    describe: () => ({
      id,
      contractVersion: "1",
      adapterVersion: "0",
      capabilities: { offline: true },
    }),
    beginConnect: vi.fn(async () => ({
      state: "device-state",
      verificationUrl: "https://wallet.example.test/verify",
      userCode: "ABCD-EFGH",
      expiresAt: new Date(NOW.getTime() + 15 * 60_000),
      intervalMs: 5_000,
    })),
    pollConnect: vi.fn(
      async (): Promise<PaymentWalletConnectResult> => ({
        status: "connected",
        credential: { secret: "credential-1", refreshAt: new Date(NOW.getTime() + 3_600_000) },
      }),
    ),
    refresh: vi.fn(
      async (credential: PaymentWalletCredential): Promise<PaymentWalletCredential> => ({
        secret: `${credential.secret}-next`,
        refreshAt: new Date(Date.now() + 3_600_000),
      }),
    ),
    disconnect: vi.fn(async () => undefined),
    createPurchase: vi.fn(),
    getPurchase: vi.fn(),
    revealCard: vi.fn(),
  };
  return provider;
}

/** `remote` is whether the secret store keeps credentials elsewhere, as a hosted one does. */
function setup(
  options: { provider?: ReturnType<typeof fakeProvider> | null; remote?: boolean } = {},
) {
  const { prisma, rows, loseProcessAfterCommit } = fakePrisma();
  const { store, values } = fakeSecrets(options.remote ?? true);
  const provider = options.provider === undefined ? fakeProvider() : options.provider;
  const cleanup = fakeCleanupJobs();
  const deps: PaymentWalletDeps = {
    prisma: prisma as unknown as PrismaClient,
    secretStore: store as unknown as SecretStore,
    jobs: cleanup.jobs,
    paymentWallet: provider as unknown as PaymentWalletProvider | null,
  };
  /** The worker's attempt at every queued cleanup. */
  const runCleanupJobs = () =>
    cleanup.runQueued({ prisma: deps.prisma, secrets: deps.secretStore });
  return {
    deps,
    prisma,
    rows,
    store,
    values,
    provider,
    cleanup,
    runCleanupJobs,
    loseProcessAfterCommit,
  };
}

async function connected(env: ReturnType<typeof setup>) {
  await connectPaymentWallet(env.deps, actor);
  vi.setSystemTime(new Date(Date.now() + 5_000));
  return paymentWalletStatus(env.deps, actor);
}

describe("payment wallet connection", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reads disconnected with no provider or no wallet", async () => {
    expect(await paymentWalletStatus(setup({ provider: null }).deps, actor)).toEqual({
      status: "disconnected",
    });
    const env = setup();
    expect(await paymentWalletStatus(env.deps, actor)).toEqual({ status: "disconnected" });
    expect(await paymentWalletConnected(env.deps, actor.userId)).toBe(false);
  });

  it("starts a sign-in and keeps its state encrypted", async () => {
    const env = setup();
    const status = await connectPaymentWallet(env.deps, actor);
    expect(status).toEqual({
      status: "connecting",
      verificationUrl: "https://wallet.example.test/verify",
      userCode: "ABCD-EFGH",
      expiresAt: new Date(NOW.getTime() + 15 * 60_000).toISOString(),
    });
    expect(env.provider?.beginConnect).toHaveBeenCalledWith(
      { clientName: "Rakazo" },
      expect.objectContaining({ userId: actor.userId }),
    );
    const [row] = env.rows;
    expect(row).toMatchObject({ provider: "fake", status: "connecting" });
    expect(row?.ciphertext).not.toContain("device-state");
    expect(JSON.parse(env.values.get(row!.ciphertext)!)).toMatchObject({ state: "device-state" });
    expect(env.store.put).toHaveBeenCalledWith(expect.any(String), expect.anything(), {
      recordId: "payment-wallet:user-1",
    });
  });

  it("waits for the next poll time before asking the provider", async () => {
    const env = setup();
    await connectPaymentWallet(env.deps, actor);
    expect((await paymentWalletStatus(env.deps, actor)).status).toBe("connecting");
    expect(env.provider?.pollConnect).not.toHaveBeenCalled();
  });

  it("stores the credential once the sign-in completes", async () => {
    const env = setup();
    const status = await connected(env);
    expect(status).toEqual({
      status: "connected",
      connectedAt: new Date(Date.now()).toISOString(),
    });
    expect(env.provider?.pollConnect).toHaveBeenCalledWith("device-state", expect.anything());
    const [row] = env.rows;
    expect(row).toMatchObject({
      status: "connected",
      verificationUrl: null,
      userCode: null,
      nextPollAt: null,
    });
    expect(JSON.parse(env.values.get(row!.ciphertext)!)).toEqual({ secret: "credential-1" });
    // The pending sign-in state is forgotten.
    expect(env.values.size).toBe(1);
    expect(await paymentWalletConnected(env.deps, actor.userId)).toBe(true);
  });

  it("calls back once on the connect transition", async () => {
    const env = setup();
    await connectPaymentWallet(env.deps, actor);
    vi.setSystemTime(new Date(Date.now() + 5_000));
    const onConnected = vi.fn(async () => undefined);
    await paymentWalletStatus(env.deps, actor, { onConnected });
    await paymentWalletStatus(env.deps, actor, { onConnected });
    expect(onConnected).toHaveBeenCalledTimes(1);
  });

  it("polls once when two readers race", async () => {
    const env = setup();
    const poll = deferred<PaymentWalletConnectResult>();
    env.provider!.pollConnect.mockImplementationOnce(() => poll.promise);
    await connectPaymentWallet(env.deps, actor);
    vi.setSystemTime(new Date(Date.now() + 5_000));
    const first = paymentWalletStatus(env.deps, actor);
    await vi.waitFor(() => expect(env.provider?.pollConnect).toHaveBeenCalledTimes(1));
    expect((await paymentWalletStatus(env.deps, actor)).status).toBe("connecting");
    poll.resolve({ status: "pending" });
    expect((await first).status).toBe("connecting");
    expect(env.provider?.pollConnect).toHaveBeenCalledTimes(1);
  });

  it("does not start another check while a slow one is still running", async () => {
    const env = setup();
    const poll = deferred<PaymentWalletConnectResult>();
    env.provider!.pollConnect.mockImplementationOnce(() => poll.promise);
    await connectPaymentWallet(env.deps, actor);
    vi.setSystemTime(new Date(Date.now() + 5_000));
    const first = paymentWalletStatus(env.deps, actor);
    await vi.waitFor(() => expect(env.provider?.pollConnect).toHaveBeenCalledTimes(1));
    // Past the sign-in interval but within the provider timeout.
    vi.setSystemTime(new Date(Date.now() + 20_000));
    await paymentWalletStatus(env.deps, actor);
    expect(env.provider?.pollConnect).toHaveBeenCalledTimes(1);
    poll.resolve({ status: "pending" });
    await first;
    expect(env.rows[0]?.nextPollAt).toEqual(new Date(Date.now() + 5_000));
  });

  it("adds five seconds to the interval each time the provider asks to slow down", async () => {
    const env = setup();
    env.provider!.pollConnect.mockResolvedValue({ status: "pending", slowDown: true });
    await connectPaymentWallet(env.deps, actor);
    vi.setSystemTime(new Date(Date.now() + 5_000));
    await paymentWalletStatus(env.deps, actor);
    expect(env.rows[0]).toMatchObject({
      pollIntervalMs: 10_000,
      nextPollAt: new Date(Date.now() + 10_000),
    });
    vi.setSystemTime(new Date(Date.now() + 10_000));
    await paymentWalletStatus(env.deps, actor);
    expect(env.rows[0]?.pollIntervalMs).toBe(15_000);
  });

  it.each(["denied", "expired"] as const)("forgets a %s sign-in", async (outcome) => {
    const env = setup();
    env.provider!.pollConnect.mockResolvedValueOnce({ status: outcome });
    await connectPaymentWallet(env.deps, actor);
    vi.setSystemTime(new Date(Date.now() + 5_000));
    expect(await paymentWalletStatus(env.deps, actor)).toEqual({ status: "disconnected" });
    expect(env.rows).toHaveLength(0);
    expect(env.values.size).toBe(0);
  });

  it("forgets a sign-in past its deadline without polling", async () => {
    const env = setup();
    await connectPaymentWallet(env.deps, actor);
    vi.setSystemTime(new Date(NOW.getTime() + 16 * 60_000));
    expect(await paymentWalletStatus(env.deps, actor)).toEqual({ status: "disconnected" });
    expect(env.provider?.pollConnect).not.toHaveBeenCalled();
    expect(env.rows).toHaveLength(0);
  });

  it("forgets and revokes a completed sign-in whose save fails", async () => {
    const env = setup();
    await connectPaymentWallet(env.deps, actor);
    vi.setSystemTime(new Date(Date.now() + 5_000));
    const saveFailure = new Error("database unavailable");
    env.prisma.paymentWallet.updateMany
      .mockImplementationOnce(async () => ({ count: 1 }))
      .mockRejectedValueOnce(saveFailure);
    await expect(paymentWalletStatus(env.deps, actor)).rejects.toBe(saveFailure);
    expect([...env.values.values()].some((value) => value.includes("credential-1"))).toBe(false);
    expect(env.provider?.disconnect).toHaveBeenCalledWith(
      expect.objectContaining({ secret: "credential-1" }),
      expect.anything(),
    );
  });

  it("keeps a sign-in pending when the provider check fails", async () => {
    const env = setup();
    env.provider!.pollConnect.mockRejectedValueOnce(new Error("network down token=leak"));
    await connectPaymentWallet(env.deps, actor);
    vi.setSystemTime(new Date(Date.now() + 5_000));
    expect((await paymentWalletStatus(env.deps, actor)).status).toBe("connecting");
    expect(env.rows[0]?.status).toBe("connecting");
  });

  it("revokes the connected wallet when connecting again", async () => {
    const env = setup();
    await connected(env);
    const before = env.rows[0]!.ciphertext;
    await connectPaymentWallet(env.deps, actor);
    expect(env.provider?.disconnect).toHaveBeenCalledWith(
      expect.objectContaining({ secret: "credential-1" }),
      expect.anything(),
    );
    expect(env.rows).toHaveLength(1);
    expect(env.rows[0]?.status).toBe("connecting");
    expect(env.values.has(before)).toBe(false);
  });

  it("disconnects by revoking and forgetting, even when revoking fails", async () => {
    const env = setup();
    await connected(env);
    env.provider!.disconnect.mockRejectedValueOnce(new Error("offline"));
    expect(await disconnectPaymentWallet(env.deps, actor)).toEqual({ status: "disconnected" });
    expect(env.provider?.disconnect).toHaveBeenCalledTimes(1);
    expect(env.rows).toHaveLength(0);
    expect(env.values.size).toBe(0);
  });

  it("treats a wallet from another provider as disconnected", async () => {
    const env = setup();
    await connected(env);
    const other = {
      ...env.deps,
      paymentWallet: fakeProvider("other") as unknown as PaymentWalletProvider,
    };
    expect(await paymentWalletStatus(other, actor)).toEqual({ status: "disconnected" });
    expect(await paymentWalletConnected(other, actor.userId)).toBe(false);
    await expect(withPaymentWalletCredential(other, actor, async () => 1)).rejects.toBeInstanceOf(
      PaymentWalletDisconnected,
    );
  });

  it("hands the stored credential to the caller", async () => {
    const env = setup();
    await connected(env);
    const seen = await withPaymentWalletCredential(
      env.deps,
      actor,
      async (credential) => credential,
    );
    expect(seen.secret).toBe("credential-1");
    expect(env.provider?.refresh).not.toHaveBeenCalled();
  });

  it("throws PaymentWalletDisconnected without a wallet", async () => {
    const env = setup();
    await expect(
      withPaymentWalletCredential(env.deps, actor, async () => 1),
    ).rejects.toBeInstanceOf(PaymentWalletDisconnected);
    await connectPaymentWallet(env.deps, actor);
    await expect(
      withPaymentWalletCredential(env.deps, actor, async () => 1),
    ).rejects.toBeInstanceOf(PaymentWalletDisconnected);
  });

  it("refreshes a due credential under the wallet lock and stores the rotated one", async () => {
    const env = setup();
    await connected(env);
    const before = env.rows[0]!.ciphertext;
    vi.setSystemTime(new Date(NOW.getTime() + 2 * 3_600_000));
    const seen = await withPaymentWalletCredential(
      env.deps,
      actor,
      async (credential) => credential,
    );
    expect(seen.secret).toBe("credential-1-next");
    expect(env.provider?.refresh).toHaveBeenCalledTimes(1);
    expect(env.prisma.$executeRaw).toHaveBeenCalled();
    expect(JSON.parse(env.values.get(env.rows[0]!.ciphertext)!)).toEqual({
      secret: "credential-1-next",
    });
    expect(env.values.has(before)).toBe(false);
  });

  it("adopts a credential another process already refreshed", async () => {
    const env = setup();
    await connected(env);
    vi.setSystemTime(new Date(NOW.getTime() + 2 * 3_600_000));
    // Another process refreshes between our read and our lock.
    const findUnique = env.prisma.paymentWallet.findUnique;
    const stale = await findUnique({ where: { userId: actor.userId } });
    findUnique.mockResolvedValueOnce(stale);
    const ref = (await env.store.put(JSON.stringify({ secret: "credential-other" }), {}))
      .ciphertext;
    Object.assign(env.rows[0]!, {
      ciphertext: ref,
      refreshAt: new Date(Date.now() + 3_600_000),
    });
    const seen = await withPaymentWalletCredential(
      env.deps,
      actor,
      async (credential) => credential,
    );
    expect(seen.secret).toBe("credential-other");
    expect(env.provider?.refresh).not.toHaveBeenCalled();
  });

  it("forgets the wallet when the provider rejects the refresh", async () => {
    const env = setup();
    await connected(env);
    env.provider!.refresh.mockRejectedValueOnce(new PaymentWalletDisconnected());
    vi.setSystemTime(new Date(NOW.getTime() + 2 * 3_600_000));
    const fn = vi.fn(async () => 1);
    await expect(withPaymentWalletCredential(env.deps, actor, fn)).rejects.toBeInstanceOf(
      PaymentWalletDisconnected,
    );
    expect(fn).not.toHaveBeenCalled();
    expect(env.rows).toHaveLength(0);
    expect(env.values.size).toBe(0);
  });

  it("keeps the wallet when a refresh fails for another reason", async () => {
    const env = setup();
    await connected(env);
    env.provider!.refresh.mockRejectedValueOnce(new Error("timeout"));
    vi.setSystemTime(new Date(NOW.getTime() + 2 * 3_600_000));
    await expect(withPaymentWalletCredential(env.deps, actor, async () => 1)).rejects.toThrow(
      "timeout",
    );
    expect(env.rows).toHaveLength(1);
    expect(env.values.size).toBe(1);
  });

  it("forgets the wallet when the provider revokes it mid-call", async () => {
    const env = setup();
    await connected(env);
    await expect(
      withPaymentWalletCredential(env.deps, actor, async () => {
        throw new PaymentWalletDisconnected();
      }),
    ).rejects.toBeInstanceOf(PaymentWalletDisconnected);
    expect(env.rows).toHaveLength(0);
    expect(await paymentWalletStatus(env.deps, actor)).toEqual({ status: "disconnected" });
  });

  it("keeps the wallet when the call fails for another reason", async () => {
    const env = setup();
    await connected(env);
    await expect(
      withPaymentWalletCredential(env.deps, actor, async () => {
        throw new Error("merchant down");
      }),
    ).rejects.toThrow("merchant down");
    expect(env.rows).toHaveLength(1);
  });
});

describe("payment wallet secret cleanup", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const walletSecret = (ref: string) => ({
    kind: "payment_wallet",
    recordId: `payment-wallet:${actor.userId}`,
    ref,
  });

  it("records the cleanup with the disconnect and removes it once the credential is deleted", async () => {
    const env = setup();
    await connected(env);
    const before = env.rows[0]!.ciphertext;
    env.cleanup.jobs.enqueueIn.mockClear();
    env.store.delete.mockClear();
    await disconnectPaymentWallet(env.deps, actor);
    expect(env.cleanup.jobs.enqueueIn).toHaveBeenCalledWith(
      env.prisma,
      expect.objectContaining({ payload: walletSecret(before), availableAt: expect.any(Date) }),
    );
    expect(env.store.delete).toHaveBeenCalledWith(
      before,
      expect.objectContaining({ recordId: `payment-wallet:${actor.userId}` }),
    );
    expect(env.cleanup.queued.size).toBe(0);
  });

  it("retries a failed delete from the job without failing the disconnect", async () => {
    const env = setup();
    await connected(env);
    const before = env.rows[0]!.ciphertext;
    env.store.delete.mockRejectedValueOnce(new Error("secret store unavailable"));
    expect(await disconnectPaymentWallet(env.deps, actor)).toEqual({ status: "disconnected" });
    expect(env.values.has(before)).toBe(true);
    expect(env.cleanup.cleanups()).toEqual([{ ...walletSecret(before), due: true }]);
    await env.runCleanupJobs();
    expect(env.values.size).toBe(0);
  });

  it("deletes a forgotten credential from the job when the process is lost after the commit", async () => {
    const env = setup();
    await connected(env);
    const before = env.rows[0]!.ciphertext;
    env.loseProcessAfterCommit();
    await expect(disconnectPaymentWallet(env.deps, actor)).rejects.toThrow(
      "process lost after commit",
    );
    expect(env.rows).toHaveLength(0);
    expect(env.values.has(before)).toBe(true);
    expect(env.cleanup.cleanups()).toEqual([{ ...walletSecret(before), due: false }]);
    await env.runCleanupJobs();
    expect(env.values.size).toBe(0);
  });

  it("keeps a refreshed credential that was saved and deletes only the one it replaced", async () => {
    const env = setup();
    await connected(env);
    const before = env.rows[0]!.ciphertext;
    vi.setSystemTime(new Date(NOW.getTime() + 2 * 3_600_000));
    env.loseProcessAfterCommit();
    await expect(withPaymentWalletCredential(env.deps, actor, async () => 1)).rejects.toThrow(
      "process lost after commit",
    );
    const saved = env.rows[0]!.ciphertext;
    expect(saved).not.toBe(before);
    // The direct attempt at the new credential found the wallet holding it and left it alone.
    expect(env.values.has(saved)).toBe(true);
    expect(env.values.has(before)).toBe(true);
    expect(env.cleanup.cleanups()).toEqual([{ ...walletSecret(before), due: false }]);
    await env.runCleanupJobs();
    expect([...env.values.keys()]).toEqual([saved]);
  });

  it("deletes a finished sign-in's state from the job when the process is lost after the commit", async () => {
    const env = setup();
    await connectPaymentWallet(env.deps, actor);
    const signIn = env.rows[0]!.ciphertext;
    vi.setSystemTime(new Date(Date.now() + 5_000));
    env.loseProcessAfterCommit();
    await expect(paymentWalletStatus(env.deps, actor)).rejects.toThrow("process lost after commit");
    const saved = env.rows[0]!.ciphertext;
    expect(env.rows[0]?.status).toBe("connected");
    expect(env.values.has(saved)).toBe(true);
    expect(env.cleanup.cleanups()).toEqual([{ ...walletSecret(signIn), due: false }]);
    await env.runCleanupJobs();
    expect([...env.values.keys()]).toEqual([saved]);
  });

  it("never deletes the credential the wallet holds, from a late job either", async () => {
    const env = setup();
    await connected(env);
    const held = env.rows[0]!.ciphertext;
    await env.deps.jobs.enqueue({ name: "secret.cleanup", payload: walletSecret(held) as never });
    env.store.delete.mockClear();
    await env.runCleanupJobs();
    expect(env.store.delete).not.toHaveBeenCalled();
    expect(env.values.has(held)).toBe(true);
  });

  it("copies no sealed credential into a job when the store keeps it in the row", async () => {
    const env = setup({ remote: false });
    await connected(env);
    vi.setSystemTime(new Date(NOW.getTime() + 2 * 3_600_000));
    await withPaymentWalletCredential(env.deps, actor, async () => 1);
    env.store.delete.mockRejectedValueOnce(new Error("notification failed"));
    expect(await disconnectPaymentWallet(env.deps, actor)).toEqual({ status: "disconnected" });
    expect(env.cleanup.jobs.enqueue).not.toHaveBeenCalled();
    expect(env.cleanup.jobs.enqueueIn).not.toHaveBeenCalled();
  });
});
