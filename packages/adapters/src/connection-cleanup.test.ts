import type {
  AdapterContext,
  BackgroundJob,
  ManagedConnectorProvider,
  SecretStore,
} from "@rakazo/adapter-kit";
import {
  CONNECTION_CLEANUP_MAX_ATTEMPTS,
  connectionCleanupJobKey,
  RetryJobLaterError,
} from "@rakazo/adapter-kit";
import type { Deferred } from "@rakazo/core/test-async";
import { deferred } from "@rakazo/core/test-async";
import type { PrismaClient } from "@rakazo/db";
import { currentDbContext, runProviderTransaction } from "@rakazo/db";
import { createLogger, createTestSink, installLogger, wrapJobPayload } from "@rakazo/logging";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBackgroundJobHandlers } from "./background-job-handlers.js";
import {
  dropLeftoverAuthorization,
  leftoverAuthorization,
  providerScopeKey,
  recordConnectionCleanupAttemptsExhausted,
} from "./connection-cleanup.js";
import { IntegrationProviderSettings } from "./integration-provider-settings.js";

const scope = {
  spaceId: "space-1",
  userId: "user-1",
  connectorId: "connector-1",
  provider: "mail",
};
const request = { ...scope, ref: "request-1" };

function cleanupJob(connector: Record<string, unknown> | undefined) {
  const connection = {
    // Active rows that have saved the authorization being removed.
    count: vi.fn(async (_args: { where: { providerRef: string } }) => 0),
    findMany: vi.fn(
      async (): Promise<Array<{ providerRef: string | null; status?: string }>> => [],
    ),
  };
  const integrationProviderConfig = { findUnique: vi.fn(async (): Promise<null> => null) };
  const tx = {
    connection,
    integrationProviderConfig,
    // The scope's lock, free unless a test says another flow holds it.
    $queryRaw: vi.fn(async () => [{ locked: true }]),
  };
  const prisma = {
    integrationProviderConfig,
    $transaction: vi.fn(async (fn: (client: typeof tx) => unknown) => fn(tx)),
  };
  const jobs = { enqueue: vi.fn(async (_job: BackgroundJob) => undefined) };
  const handlers = createBackgroundJobHandlers({
    prisma,
    jobs,
    connectors: { managed: () => connector },
  } as unknown as Parameters<typeof createBackgroundJobHandlers>[0]);
  const sink = createTestSink();
  installLogger(createLogger({ service: "rakazo-worker", sinks: [sink] }));
  const errors = () => sink.events.filter((event) => event.level === "error");
  return { run: handlers["connection.cleanup"], connection, tx, prisma, jobs, errors };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("connection.cleanup", () => {
  it("fails while the provider refuses the cancel, so the queue retries until it is gone", async () => {
    const cancelAuthorizationRequest = vi
      .fn(async () => {
        expect(currentDbContext()).toEqual({
          kind: "tenant",
          spaceId: "space-1",
          userId: "user-1",
        });
      })
      .mockRejectedValueOnce(new Error("provider unavailable"));
    const { run } = cleanupJob({ cancelAuthorizationRequest });

    await expect(run(request)).rejects.toThrow("provider unavailable");
    await expect(run(request)).resolves.toBeUndefined();
    expect(cancelAuthorizationRequest).toHaveBeenLastCalledWith(
      "request-1",
      expect.objectContaining({ spaceId: "space-1", userId: "user-1" }),
    );
  });

  it("revokes the account a request became, and only an answer of none counts as nothing to revoke", async () => {
    const revoke = vi.fn(async () => undefined);
    const resolveConnectedAccountId = vi
      .fn(async (): Promise<string | undefined> => "account-1")
      .mockRejectedValueOnce(new Error("provider unavailable"))
      .mockResolvedValueOnce(undefined);
    const { run } = cleanupJob({ revoke, resolveConnectedAccountId });

    await expect(run(request)).rejects.toThrow("provider unavailable");
    await expect(run(request)).resolves.toBeUndefined();
    expect(revoke).not.toHaveBeenCalled();

    await run(request);
    expect(revoke).toHaveBeenCalledWith("account-1", expect.anything());
  });

  it("leaves an account that a row has saved since the failure", async () => {
    const cancelAuthorizationRequest = vi.fn(async () => undefined);
    const { run, connection } = cleanupJob({ cancelAuthorizationRequest });
    connection.count.mockResolvedValue(1);

    await expect(run(request)).resolves.toBeUndefined();
    expect(connection.count).toHaveBeenCalledWith({
      where: {
        ...scope,
        providerRef: "request-1",
        status: { in: ["connected", "pending", "error"] },
      },
    });
    expect(cancelAuthorizationRequest).not.toHaveBeenCalled();
  });

  it("leaves an account a row has saved under the id its request resolved to", async () => {
    const revoke = vi.fn(async () => undefined);
    const resolveConnectedAccountId = vi.fn(async (): Promise<string | undefined> => "account-1");
    const { run, connection } = cleanupJob({ revoke, resolveConnectedAccountId });
    connection.count.mockImplementation(async ({ where }) =>
      where.providerRef === "account-1" ? 1 : 0,
    );

    await expect(run(request)).resolves.toBeUndefined();
    expect(revoke).not.toHaveBeenCalled();

    connection.count.mockResolvedValue(0);
    await run(request);
    expect(revoke).toHaveBeenCalledWith("account-1", expect.anything());
  });

  it("fails, removing nothing, when it cannot read which rows have saved the authorization", async () => {
    const cancelAuthorizationRequest = vi.fn(async () => undefined);
    const { run, connection } = cleanupJob({ cancelAuthorizationRequest });
    connection.count.mockRejectedValue(new Error("database unavailable"));

    await expect(run(request)).rejects.toThrow("database unavailable");
    expect(cancelAuthorizationRequest).not.toHaveBeenCalled();
  });

  it("deletes the accounts no row references, keeping the referenced ones", async () => {
    const revokeUnreferencedAccounts = vi.fn(async () => undefined);
    const { run, connection } = cleanupJob({ revokeUnreferencedAccounts });
    connection.findMany.mockResolvedValue([{ providerRef: "account-1" }]);

    await run(scope);
    expect(revokeUnreferencedAccounts).toHaveBeenCalledWith(
      "mail",
      ["account-1"],
      expect.anything(),
    );
  });

  it("stays queued while a sibling has not saved its account, and removes the rest once it has", async () => {
    const revokeUnreferencedAccounts = vi.fn(async () => undefined);
    const { run, connection } = cleanupJob({ revokeUnreferencedAccounts });
    // A row without a concrete account id may own any remote account, so nothing is deleted yet.
    for (const pending of ["mail", null]) {
      connection.findMany.mockResolvedValue([
        { providerRef: "account-1" },
        { providerRef: pending },
      ]);
      await expect(run(scope)).rejects.toBeInstanceOf(RetryJobLaterError);
    }
    expect(revokeUnreferencedAccounts).not.toHaveBeenCalled();

    connection.findMany.mockResolvedValue([
      { providerRef: "account-1" },
      { providerRef: "account-2" },
    ]);
    await expect(run(scope)).resolves.toBeUndefined();
    expect(revokeUnreferencedAccounts).toHaveBeenCalledWith(
      "mail",
      ["account-1", "account-2"],
      expect.anything(),
    );
  });

  it("does not wait for a failed connection that saved nothing", async () => {
    const revokeUnreferencedAccounts = vi.fn(async () => undefined);
    const { run, connection } = cleanupJob({ revokeUnreferencedAccounts });
    // The begin this cleanup is for left its own row failed, with no reference: it owns nothing.
    connection.findMany.mockResolvedValue([
      { providerRef: "account-1", status: "connected" },
      { providerRef: null, status: "error" },
    ]);
    await expect(run(scope)).resolves.toBeUndefined();
    expect(revokeUnreferencedAccounts).toHaveBeenCalledWith(
      "mail",
      ["account-1"],
      expect.anything(),
    );

    // A failed row that names the app, or one still connecting, may own an account.
    for (const sibling of [
      { providerRef: "mail", status: "error" },
      { providerRef: null, status: "pending" },
      { providerRef: null, status: "connected" },
    ]) {
      revokeUnreferencedAccounts.mockClear();
      connection.findMany.mockResolvedValue([sibling]);
      await expect(run(scope)).rejects.toBeInstanceOf(RetryJobLaterError);
      expect(revokeUnreferencedAccounts).not.toHaveBeenCalled();
    }
  });

  it("says what it waits for when it asks the queue for a later try", async () => {
    const { run, connection } = cleanupJob({ revokeUnreferencedAccounts: vi.fn() });
    connection.findMany.mockResolvedValue([{ providerRef: null, status: "pending" }]);

    const waiting = await run(scope).catch((error: unknown) => error);
    expect(waiting).toBeInstanceOf(RetryJobLaterError);
    expect((waiting as RetryJobLaterError).delayMs).toBe(10 * 60_000);
    expect((waiting as RetryJobLaterError).cause).toEqual(
      new Error("An unfinished connection of this app may own the accounts"),
    );
  });

  it("leaves a scope another flow holds to that flow, without failing or calling the provider", async () => {
    const cancelAuthorizationRequest = vi.fn(async () => undefined);
    const { run, tx, jobs, errors } = cleanupJob({ cancelAuthorizationRequest });
    tx.$queryRaw.mockResolvedValueOnce([{ locked: false }]);
    const before = Date.now();

    await expect(run(request)).resolves.toBeUndefined();
    expect(cancelAuthorizationRequest).not.toHaveBeenCalled();
    // Rescheduled under its own key for a little later, so the wait costs none of its retries.
    expect(jobs.enqueue).toHaveBeenCalledTimes(1);
    const again = jobs.enqueue.mock.calls[0]![0];
    expect(again).toMatchObject({
      name: "connection.cleanup",
      payload: request,
      replaceKey: connectionCleanupJobKey(request),
      maxAttempts: CONNECTION_CLEANUP_MAX_ATTEMPTS,
    });
    expect(again.availableAt!.getTime()).toBeGreaterThan(before);
    expect(errors()).toEqual([]);

    await run(request);
    expect(cancelAuthorizationRequest).toHaveBeenCalledWith("request-1", expect.anything());
    expect(jobs.enqueue).toHaveBeenCalledTimes(1);
  });

  it("reschedules instead of failing when this process is already working on the scope", async () => {
    vi.useFakeTimers();
    const cancelAuthorizationRequest = vi.fn(async () => undefined);
    const { run, prisma, jobs } = cleanupJob({ cancelAuthorizationRequest });
    let release: Deferred | undefined;
    const holder = runProviderTransaction(
      providerScopeKey(scope, scope.connectorId, scope.provider),
      () => {
        release = deferred();
        return release.promise;
      },
      120_000,
    );
    try {
      const running = run(request);
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(running).resolves.toBeUndefined();
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(cancelAuthorizationRequest).not.toHaveBeenCalled();
      expect(jobs.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({ payload: request, availableAt: expect.any(Date) }),
      );
    } finally {
      release?.resolve();
      await holder;
    }
  });

  it("fails when a busy scope's cleanup cannot be rescheduled, so the queue keeps it", async () => {
    const { run, tx, jobs } = cleanupJob({ cancelAuthorizationRequest: vi.fn() });
    tx.$queryRaw.mockResolvedValueOnce([{ locked: false }]);
    jobs.enqueue.mockRejectedValueOnce(new Error("queue unavailable"));

    await expect(run(request)).rejects.toThrow("queue unavailable");
  });

  it("starts the provider's time budget once it holds the scope", async () => {
    const budget = vi.spyOn(AbortSignal, "timeout");
    const cancelAuthorizationRequest = vi.fn(async (_id: string, context: AdapterContext) => {
      expect(context.signal.aborted).toBe(false);
    });
    const revokeUnreferencedAccounts = vi.fn(async () => undefined);
    for (const [connector, payload] of [
      [{ cancelAuthorizationRequest }, request],
      [{ revokeUnreferencedAccounts }, scope],
    ] as const) {
      budget.mockClear();
      const { run, tx } = cleanupJob(connector);
      await run(payload);
      expect(budget).toHaveBeenCalledTimes(1);
      expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
        budget.mock.invocationCallOrder[0]!,
      );
    }
    expect(cancelAuthorizationRequest).toHaveBeenCalledTimes(1);
    expect(revokeUnreferencedAccounts).toHaveBeenCalledTimes(1);
  });

  it("is safe to repeat after the removal already happened", async () => {
    // Removed directly, but deleting the backup job failed: the job runs anyway.
    const revoke = vi.fn(async () => undefined);
    const resolveConnectedAccountId = vi.fn(async (): Promise<string | undefined> => undefined);
    const { run, errors } = cleanupJob({ revoke, resolveConnectedAccountId });

    await expect(run(request)).resolves.toBeUndefined();
    await expect(run(request)).resolves.toBeUndefined();
    expect(revoke).not.toHaveBeenCalled();
    expect(errors()).toEqual([]);
  });

  it("fails on a database or provider error in the unreferenced-account cleanup", async () => {
    const revokeUnreferencedAccounts = vi.fn(async () => {
      throw new Error("provider unavailable");
    });
    const { run, connection } = cleanupJob({ revokeUnreferencedAccounts });

    await expect(run(scope)).rejects.toThrow("provider unavailable");
    connection.findMany.mockRejectedValue(new Error("database unavailable"));
    await expect(run(scope)).rejects.toThrow("database unavailable");
  });

  it("finishes, reporting what to remove by hand, only when the deployment has no such connector", async () => {
    const { run, jobs, errors } = cleanupJob(undefined);

    await expect(run(request)).resolves.toBeUndefined();
    expect(errors()).toEqual([
      expect.objectContaining({
        spaceId: "space-1",
        userId: "user-1",
        connectorId: "connector-1",
        provider: "mail",
        providerRef: "request-1",
      }),
    ]);
    expect(jobs.enqueue).not.toHaveBeenCalled();
  });

  it("stays queued while its connector cannot be prepared, and removes once it can", async () => {
    const cancelAuthorizationRequest = vi.fn(async () => undefined);
    const fallbacks: { composio?: ManagedConnectorProvider } = {};
    const { prisma, jobs, errors } = cleanupJob(undefined);
    const settings = new IntegrationProviderSettings(
      prisma as unknown as PrismaClient,
      {} as SecretStore,
      "fake-identity",
      fallbacks,
    );
    const configured = settings
      .providers()
      .find((provider) => provider.describe().id === "composio");
    const handlers = createBackgroundJobHandlers({
      prisma,
      jobs,
      connectors: { managed: () => configured },
    } as unknown as Parameters<typeof createBackgroundJobHandlers>[0]);
    const cleanup = { ...request, connectorId: "composio" };

    // Its settings cannot be read, then hold no credentials: neither is a finished removal.
    prisma.integrationProviderConfig.findUnique.mockRejectedValueOnce(
      new Error("database unavailable"),
    );
    await expect(handlers["connection.cleanup"](cleanup)).rejects.toThrow("database unavailable");
    // Missing credentials are waited for, which the queue does not report as a failed try.
    await expect(handlers["connection.cleanup"](cleanup)).rejects.toBeInstanceOf(
      RetryJobLaterError,
    );
    expect(cancelAuthorizationRequest).not.toHaveBeenCalled();
    expect(errors()).toEqual([]);

    // Credentials saved between preparing them and taking the lock: tried again soon, with them.
    fallbacks.composio = { cancelAuthorizationRequest } as unknown as ManagedConnectorProvider;
    prisma.integrationProviderConfig.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ ciphertext: "saved-meanwhile" } as never);
    await expect(handlers["connection.cleanup"](cleanup)).resolves.toBeUndefined();
    expect(cancelAuthorizationRequest).not.toHaveBeenCalled();
    expect(jobs.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ payload: cleanup, availableAt: expect.any(Date) }),
    );

    await expect(handlers["connection.cleanup"](cleanup)).resolves.toBeUndefined();
    expect(cancelAuthorizationRequest).toHaveBeenCalledWith("request-1", expect.anything());
    expect(errors()).toEqual([]);
  });
});

describe("a direct removal", () => {
  function directRemoval(
    connector: Record<string, unknown>,
    leftover: typeof scope & { ref?: string } = request,
  ) {
    const { prisma, connection, tx } = cleanupJob(connector);
    const jobs = { cancelIn: vi.fn(async (_tx: unknown, _key: string) => undefined) };
    const run = () =>
      dropLeftoverAuthorization(
        { prisma: prisma as unknown as PrismaClient, jobs },
        connector as unknown as ManagedConnectorProvider,
        leftover,
        "connections.begin",
      );
    return { run, connection, tx, prisma, jobs };
  }

  it("takes the scope's lock and reads which rows refer to the authorization before removing it", async () => {
    const cancelAuthorizationRequest = vi.fn(async () => undefined);
    const { run, connection, tx, jobs } = directRemoval({ cancelAuthorizationRequest });

    await expect(run()).resolves.toBe("done");
    const [locked, read, removed, unrecorded] = [
      tx.$queryRaw.mock.invocationCallOrder[0]!,
      connection.count.mock.invocationCallOrder[0]!,
      cancelAuthorizationRequest.mock.invocationCallOrder[0]!,
      jobs.cancelIn.mock.invocationCallOrder[0]!,
    ];
    expect(locked).toBeLessThan(read);
    expect(read).toBeLessThan(removed);
    // The backup job goes in the transaction that holds the lock, after the removal.
    expect(removed).toBeLessThan(unrecorded);
    expect(jobs.cancelIn).toHaveBeenCalledWith(tx, connectionCleanupJobKey(request));
  });

  it("never removes an authorization an active row has saved", async () => {
    const cancelAuthorizationRequest = vi.fn(async () => undefined);
    const revoke = vi.fn(async () => undefined);
    for (const connector of [{ cancelAuthorizationRequest }, { revoke }]) {
      const { run, connection, jobs } = directRemoval(connector);
      connection.count.mockResolvedValue(1);
      await expect(run()).resolves.toBe("done");
      // The row keeps the authorization, so nothing is left for the job.
      expect(jobs.cancelIn).toHaveBeenCalledTimes(1);
    }
    expect(cancelAuthorizationRequest).not.toHaveBeenCalled();
    expect(revoke).not.toHaveBeenCalled();
  });

  it("removes nothing while another flow holds the scope, or when the rows cannot be read", async () => {
    const cancelAuthorizationRequest = vi.fn(async () => undefined);
    const busy = directRemoval({ cancelAuthorizationRequest });
    busy.tx.$queryRaw.mockResolvedValueOnce([{ locked: false }]);
    await expect(busy.run()).resolves.toBe("busy");
    expect(busy.jobs.cancelIn).not.toHaveBeenCalled();

    const unreadable = directRemoval({ cancelAuthorizationRequest });
    unreadable.connection.count.mockRejectedValue(new Error("database unavailable"));
    await expect(unreadable.run()).rejects.toThrow("database unavailable");
    expect(unreadable.jobs.cancelIn).not.toHaveBeenCalled();
    expect(cancelAuthorizationRequest).not.toHaveBeenCalled();
  });

  it("keeps the job when the removal failed, and fails when the job cannot be deleted", async () => {
    const refused = directRemoval({
      cancelAuthorizationRequest: vi.fn(async () => {
        throw new Error("provider unavailable");
      }),
    });
    await expect(refused.run()).rejects.toThrow("provider unavailable");
    expect(refused.jobs.cancelIn).not.toHaveBeenCalled();

    // The transaction fails with the delete, so the caller hands over to the job that remains.
    const undeleted = directRemoval({ cancelAuthorizationRequest: vi.fn(async () => undefined) });
    undeleted.jobs.cancelIn.mockRejectedValue(new Error("queue unavailable"));
    await expect(undeleted.run()).rejects.toThrow("queue unavailable");
  });

  it("leaves the job that every cleanup of an app's accounts in the scope shares", async () => {
    // Another flow may have recorded that job since this one listed the accounts.
    const revokeUnreferencedAccounts = vi.fn(async () => undefined);
    const { run, jobs } = directRemoval({ revokeUnreferencedAccounts }, scope);

    await expect(run()).resolves.toBe("done");
    expect(revokeUnreferencedAccounts).toHaveBeenCalledTimes(1);
    expect(jobs.cancelIn).not.toHaveBeenCalled();
  });
});

describe("a connection cleanup that runs out of attempts", () => {
  it("has attempts for about a month of the queue's backoff", () => {
    // The queue waits e^attempt seconds after a failed try, capped at e^10.
    let seconds = 0;
    for (let attempt = 1; attempt < CONNECTION_CLEANUP_MAX_ATTEMPTS; attempt += 1)
      seconds += Math.exp(Math.min(attempt, 10));
    expect(seconds / 86_400).toBeGreaterThan(28);
  });

  it("is reported with what to remove by hand, and never with the provider's raw error", () => {
    const sink = createTestSink();
    installLogger(createLogger({ service: "rakazo-worker", sinks: [sink] }));
    const failed = (task_identifier: string, payload: unknown) =>
      recordConnectionCleanupAttemptsExhausted(
        { task_identifier, payload: wrapJobPayload(payload), attempts: 125 },
        new Error("401 api_key=fake-provider-key"),
      );

    failed("history.compact", { threadId: "thread-1" });
    expect(sink.events).toEqual([]);

    failed("connection.cleanup", request);
    failed("connection.cleanup", scope);
    expect(sink.events).toEqual([
      expect.objectContaining({
        level: "error",
        ...scope,
        providerRef: "request-1",
        "job.attempts": 125,
      }),
      expect.objectContaining({ level: "error", ...scope, "job.attempts": 125 }),
    ]);
    expect(sink.events[1]).not.toHaveProperty("providerRef");
    expect(JSON.stringify(sink.events)).not.toContain("fake-provider-key");
  });
});

describe("leftoverAuthorization", () => {
  const connector = (methods: Record<string, unknown> = {}) =>
    methods as unknown as ManagedConnectorProvider;

  it("names a request or account by id, and an app only when its accounts can be listed", () => {
    expect(leftoverAuthorization(connector(), scope, " request-1 ")).toEqual(request);
    expect(leftoverAuthorization(connector(), scope, "mail")).toBeUndefined();
    expect(
      leftoverAuthorization(connector({ revokeUnreferencedAccounts: vi.fn() }), scope, "mail"),
    ).toEqual(scope);
    expect(leftoverAuthorization(connector(), scope, undefined)).toBeUndefined();
  });
});
