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
import type { PrismaClient } from "@rakazo/db";
import { currentDbContext, runProviderTransaction } from "@rakazo/db";
import { createLogger, createTestSink, installLogger, wrapJobPayload } from "@rakazo/logging";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBackgroundJobHandlers } from "./background-job-handlers.js";
import {
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
    findFirst: vi.fn(async (): Promise<{ id: string } | null> => null),
    findMany: vi.fn(async (): Promise<Array<{ providerRef: string | null }>> => []),
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
    connection.findFirst.mockResolvedValue({ id: "connection-2" });

    await run(request);
    expect(connection.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ ...scope, providerRef: "request-1" }),
      }),
    );
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
    let release = () => {};
    const holder = runProviderTransaction(
      providerScopeKey(scope, scope.connectorId, scope.provider),
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
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
      release();
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

  it("fails, so the queue retries, while its connector cannot be prepared, and removes once it can", async () => {
    const cancelAuthorizationRequest = vi.fn(async () => undefined);
    const fallbacks: { composio?: ManagedConnectorProvider } = {};
    const { prisma, errors } = cleanupJob(undefined);
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
      jobs: { enqueue: vi.fn() },
      connectors: { managed: () => configured },
    } as unknown as Parameters<typeof createBackgroundJobHandlers>[0]);
    const cleanup = { ...request, connectorId: "composio" };

    // Its settings cannot be read, then hold no credentials: neither is a finished removal.
    prisma.integrationProviderConfig.findUnique.mockRejectedValueOnce(
      new Error("database unavailable"),
    );
    await expect(handlers["connection.cleanup"](cleanup)).rejects.toThrow("database unavailable");
    await expect(handlers["connection.cleanup"](cleanup)).rejects.toThrow("no credentials");
    expect(cancelAuthorizationRequest).not.toHaveBeenCalled();
    expect(errors()).toEqual([]);

    fallbacks.composio = { cancelAuthorizationRequest } as unknown as ManagedConnectorProvider;
    await expect(handlers["connection.cleanup"](cleanup)).resolves.toBeUndefined();
    expect(cancelAuthorizationRequest).toHaveBeenCalledWith("request-1", expect.anything());
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
