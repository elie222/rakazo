import { createRouterClient } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import type { BackgroundJob } from "@rakazo/adapter-kit";
import {
  ConnectorAuthUnavailableError,
  connectionCleanupJob,
  connectionCleanupJobKey,
} from "@rakazo/adapter-kit";
import { providerScopeKey } from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import { CONNECTOR_AUTH_UNAVAILABLE } from "@rakazo/contracts";
import { deferred } from "@rakazo/core/test-async";
import type { PrismaClient } from "@rakazo/db";
import { IsolationError, runProviderTransaction } from "@rakazo/db";
import { createLogger, createTestSink, installLogger } from "@rakazo/logging";
import { describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "../router.js";
import { appHandler, createRouter, handle } from "../router-test-support.js";
import { beginConnection } from "./connection-flows.js";

describe("connections.begin", () => {
  it("reuses a revoked row for the same provider instead of inserting a duplicate", async () => {
    const begin = vi.fn().mockResolvedValue({ state: "gmail-state", authorizationUrl: null });
    const update = vi.fn().mockResolvedValue({
      id: "conn-old",
      connectorId: "composio",
      provider: "gmail",
      displayName: "Gmail",
      status: "pending",
      createdAt: new Date("2026-08-26T00:00:00.000Z"),
    });
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const create = vi.fn();
    const prisma = {
      $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
        const tx = {
          $executeRaw: vi.fn().mockResolvedValue(undefined),
          connection: {
            findMany: vi.fn().mockResolvedValue([{ id: "conn-old", status: "revoked" }]),
            update,
            updateMany,
            create,
          },
        };
        return fn(tx);
      }),
    } as unknown as PrismaClient;
    const analytics = { capture: vi.fn(), flush: vi.fn() };
    const deps = {
      prisma,
      analytics,
      connectors: {
        managed: vi.fn(() => ({ begin })),
      },
      env: {
        defaultProvider: "fake",
        defaultModel: "fake-model",
        webOrigin: "http://127.0.0.1:5173",
        screenProxySecret: "fake-test-secret",
        sandboxProvider: "fake",
      },
      dataDir: "/tmp/rakazo-router-test",
    } as unknown as RouterDeps;
    const actor = {
      spaceId: "workspace-1",
      userId: "user-1",
      email: "user@rakazo.test",
      isDeploymentOwner: true,
    } satisfies Actor;
    const handler = new RPCHandler(createRouter(deps));

    const response = await handle(
      handler,
      new Request("http://127.0.0.1/rpc/connections/begin", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          json: {
            connectorId: "composio",
            provider: "gmail",
            displayName: "Gmail",
          },
        }),
      }),
      { prefix: "/rpc", context: { actor } },
    );

    expect(response.status).toBe(200);
    expect(begin).toHaveBeenCalledWith(
      { provider: "gmail", redirectUrl: "http://127.0.0.1:5173/integrations/callback" },
      expect.anything(),
    );
    // Complete and revoke hold the same lock across provider calls; begin must outwait them.
    expect(vi.mocked(prisma.$transaction).mock.calls.map((call) => call[1])).toEqual([
      { timeout: 60_000 },
      { timeout: 60_000 },
    ]);
    // Keyed to the reused row's creation, so a reconnect repeats the earlier event and is deduped.
    expect(analytics.capture.mock.calls).toEqual([
      [
        "user-1",
        { name: "tool_connected", app: "gmail" },
        { id: "conn-old", at: new Date("2026-08-26T00:00:00.000Z") },
      ],
    ]);
    expect(create).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith({
      where: { id: "conn-old" },
      data: {
        displayName: "Gmail",
        status: "pending",
        providerRef: null,
        metadata: { attempt: expect.any(String) },
      },
    });
    // The result is saved, and a failure recorded, only while the row is still this attempt's
    // and holds nothing yet.
    const { attempt } = update.mock.calls[0]![0].data.metadata;
    expect(updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: "conn-old",
        status: "pending",
        metadata: { equals: { attempt } },
      }),
      data: expect.objectContaining({ providerRef: "gmail-state" }),
    });
    await expect(response.json()).resolves.toMatchObject({
      json: { connectionId: "conn-old" },
    });
  });

  it("leaves the removal to its job when its result cannot be saved before the slot frees", async () => {
    vi.useFakeTimers();
    const slot = deferred();
    let holder: Promise<void> = Promise.resolve();
    const begin = vi.fn(async () => {
      // Another provider call takes this scope's slot while this one talks to the provider.
      holder = runProviderTransaction(
        providerScopeKey({ spaceId: "workspace-1", userId: "user-1" }, "composio", "gmail"),
        () => slot.promise,
        120_000,
      );
      return { state: "request-1", authorizationUrl: "https://provider.test/authorize" };
    });
    const cancelAuthorizationRequest = vi.fn(async () => undefined);
    const jobs = {
      enqueue: vi.fn(async (_job: BackgroundJob) => undefined),
      cancelIn: vi.fn(async () => undefined),
    };
    const rootUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
    const tx = {
      $executeRaw: vi.fn().mockResolvedValue(undefined),
      connection: {
        findMany: vi.fn().mockResolvedValue([]),
        create: vi.fn().mockResolvedValue({ id: "conn-1", status: "pending" }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const prisma = {
      connection: { updateMany: rootUpdateMany },
      $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(tx)),
    } as unknown as PrismaClient;
    const handler = new RPCHandler(
      createRouter({
        prisma,
        jobs,
        connectors: { managed: vi.fn(() => ({ begin, cancelAuthorizationRequest })) },
        env: {
          defaultProvider: "fake",
          defaultModel: "fake-model",
          webOrigin: "http://127.0.0.1:5173",
          screenProxySecret: "fake-test-secret",
          sandboxProvider: "fake",
        },
        dataDir: "/tmp/rakazo-router-test",
      } as unknown as RouterDeps),
    );
    try {
      const handled = handle(
        handler,
        new Request("http://127.0.0.1/rpc/connections/begin", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            json: { connectorId: "composio", provider: "gmail", displayName: "Gmail" },
          }),
        }),
        {
          prefix: "/rpc",
          context: {
            actor: {
              spaceId: "workspace-1",
              userId: "user-1",
              email: "user@rakazo.test",
              isDeploymentOwner: true,
            },
          },
        },
      );
      await vi.advanceTimersByTimeAsync(70_000);
      const response = await handled;

      expect(response.status).not.toBe(200);
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(tx.connection.updateMany).not.toHaveBeenCalled();
      // A removal needs the scope as much as the save did: without it nothing is removed, and
      // the recorded job stays for when the scope is free.
      expect(cancelAuthorizationRequest).not.toHaveBeenCalled();
      expect(jobs.enqueue).toHaveBeenCalledTimes(2);
      expect(jobs.enqueue).toHaveBeenLastCalledWith(
        expect.objectContaining({ payload: LEFTOVER_REQUEST, availableAt: expect.any(Date) }),
      );
      expect(jobs.cancelIn).not.toHaveBeenCalled();
      expect(rootUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: { status: "error" } }),
      );
    } finally {
      slot.resolve();
      await holder;
      vi.useRealTimers();
    }
  });

  const LEFTOVER_REQUEST = {
    spaceId: "workspace-1",
    userId: "user-1",
    connectorId: "composio",
    provider: "gmail",
    ref: "request-1",
  };
  const { ref: _ref, ...LEFTOVER_APP } = LEFTOVER_REQUEST;

  /** A begin whose row a revoke took while the provider was answering. */
  function lostBegin(
    connector: Record<string, unknown>,
    state: string,
    authorizationUrl: string | null = "https://provider.test/go",
  ) {
    const jobs = {
      enqueue: vi.fn(async (_job: BackgroundJob) => undefined),
      enqueueIn: vi.fn(async (_tx: unknown, _job: BackgroundJob) => undefined),
      // A finished removal deletes its backup job in the transaction that holds the scope's lock.
      cancelIn: vi.fn(async (_tx: unknown, _key: string) => undefined),
    };
    const tx = {
      $executeRaw: vi.fn().mockResolvedValue(undefined),
      // The scope's lock, free unless a test says another flow holds it.
      $queryRaw: vi.fn().mockResolvedValue([{ locked: true }]),
      connection: {
        findMany: vi.fn().mockResolvedValue([]),
        create: vi.fn().mockResolvedValue({ id: "conn-1", status: "pending" }),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        // Active rows that have saved the authorization a removal names.
        count: vi.fn().mockResolvedValue(0),
      },
    };
    const root = {
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      count: vi.fn().mockResolvedValue(0),
    };
    const prisma = {
      connection: root,
      $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(tx)),
    } as unknown as PrismaClient;
    const begin = vi.fn(async () => ({ state, authorizationUrl }));
    const sink = createTestSink();
    installLogger(createLogger({ service: "rakazo-api", sinks: [sink] }));
    const call = () =>
      beginConnection(
        {
          prisma,
          jobs,
          connectors: { managed: () => ({ begin, ...connector }) },
          env: { webOrigin: "http://127.0.0.1:5173" },
        } as unknown as RouterDeps,
        { actor: { spaceId: "workspace-1", userId: "user-1" } as Actor },
        { connectorId: "composio", provider: "gmail", displayName: "Gmail" },
      );
    const logged = (level: string) =>
      sink.events
        .filter((event) => event.level === level && event.message.startsWith("connections."))
        .map((event) => event.message);
    const errors = () => logged("error");
    const warnings = () => logged("warn");
    const events = () => sink.events.filter((event) => event.level === "error");
    return { call, jobs, tx, root, prisma, errors, warnings, events };
  }

  it("answers a connector this build does not have with a client error", async () => {
    const managed = vi.fn(() => undefined);
    const begin = (deps: object, connectorId?: string) =>
      beginConnection(
        { connectors: { defaultConnectorId: "first-connector", managed }, ...deps } as never,
        { actor: { spaceId: "workspace-1", userId: "user-1" } as Actor },
        { connectorId, provider: "gmail", displayName: "Gmail" },
      );
    const refusal = { name: "ClientError", kind: "BAD_REQUEST" };
    await expect(begin({}, "a-provider-since-removed")).rejects.toMatchObject({
      ...refusal,
      message: "Connector a-provider-since-removed is not configured",
    });
    expect(managed).toHaveBeenLastCalledWith("a-provider-since-removed");
    // A request that names no connector means the one the server's registry calls the default.
    await expect(begin({})).rejects.toMatchObject({
      ...refusal,
      message: "Connector first-connector is not configured",
    });
    expect(managed).toHaveBeenLastCalledWith("first-connector");
    // Saved integration settings answer only for the providers they have.
    const integrationSettings = { has: vi.fn(() => false), resolve: vi.fn() };
    await expect(begin({ integrationSettings }, "a-provider-since-removed")).rejects.toMatchObject(
      refusal,
    );
    expect(integrationSettings.resolve).not.toHaveBeenCalled();
  });

  it("returns the normalized sign-in URL that it validated", async () => {
    const { call, tx, jobs } = lostBegin(
      {},
      "request-1",
      "  https://provider.test/sign in?state=a b  ",
    );
    tx.connection.updateMany.mockResolvedValue({ count: 1 });
    await expect(call()).resolves.toEqual({
      connectionId: "conn-1",
      authorizationUrl: "https://provider.test/sign%20in?state=a%20b",
    });
    expect(jobs.enqueue).not.toHaveBeenCalled();
  });

  it.each(["example-app", "javascript:alert(1)", "file:///tmp/fixture", "custom-app:signin"])(
    "rejects an invalid sign-in URL before returning it to clients: %s",
    async (url) => {
      const cancelAuthorizationRequest = vi.fn(async () => undefined);
      const { call, jobs, tx, root } = lostBegin({ cancelAuthorizationRequest }, "request-1", url);
      await expect(call()).rejects.toMatchObject({
        kind: "SERVICE_UNAVAILABLE",
        message: "The app returned an invalid sign-in URL.",
      });
      expect(root.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: { status: "error" } }),
      );
      expect(tx.connection.updateMany).not.toHaveBeenCalled();
      expect(jobs.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({ name: "connection.cleanup" }),
      );
      expect(cancelAuthorizationRequest).toHaveBeenCalledOnce();
    },
  );

  it("records the removal with the lost race and deletes the record once it is done", async () => {
    const cancelAuthorizationRequest = vi.fn(async () => undefined);
    const { call, jobs, tx, errors } = lostBegin({ cancelAuthorizationRequest }, "request-1");

    await expect(call()).rejects.toBeInstanceOf(IsolationError);
    expect(jobs.enqueueIn).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        name: "connection.cleanup",
        payload: LEFTOVER_REQUEST,
        availableAt: expect.any(Date),
      }),
    );
    expect(cancelAuthorizationRequest).toHaveBeenCalledWith("request-1", expect.anything());
    expect(jobs.cancelIn).toHaveBeenCalledWith(tx, connectionCleanupJobKey(LEFTOVER_REQUEST));
    expect(jobs.enqueue).not.toHaveBeenCalled();
    expect(errors()).toEqual([]);
    // Removed as the job would: holding the scope's lock, after reading who refers to it.
    expect(tx.connection.count).toHaveBeenCalledWith({
      where: expect.objectContaining({ providerRef: "request-1" }),
    });
    const [locked, read, removed] = [
      tx.$queryRaw.mock.invocationCallOrder[0]!,
      tx.connection.count.mock.invocationCallOrder[0]!,
      cancelAuthorizationRequest.mock.invocationCallOrder[0]!,
    ];
    expect(locked).toBeLessThan(read);
    expect(read).toBeLessThan(removed);
  });

  it("saves its result only while the row is still its own attempt's", async () => {
    // A revoke took the row and a later begin reused it: pending again, but not this attempt's.
    const cancelAuthorizationRequest = vi.fn(async () => undefined);
    const { call, jobs, tx, root } = lostBegin({ cancelAuthorizationRequest }, "request-1");

    await expect(call()).rejects.toBeInstanceOf(IsolationError);
    const { attempt } = tx.connection.create.mock.calls[0]![0].data.metadata;
    expect(attempt).toEqual(expect.any(String));
    expect(tx.connection.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: "conn-1",
        status: "pending",
        metadata: { equals: { attempt } },
      }),
      data: expect.objectContaining({ providerRef: "request-1" }),
    });
    // Its own authorization is removed, and the other attempt's row is not marked failed.
    expect(cancelAuthorizationRequest).toHaveBeenCalledWith("request-1", expect.anything());
    expect(jobs.cancelIn).toHaveBeenCalledWith(tx, connectionCleanupJobKey(LEFTOVER_REQUEST));
    expect(root.updateMany).not.toHaveBeenCalled();
  });

  it("never removes an authorization that an active row has saved", async () => {
    // The provider answered begin with an account a sibling connection already uses.
    const cancelAuthorizationRequest = vi.fn(async () => undefined);
    const revoke = vi.fn(async () => undefined);
    for (const connector of [{ cancelAuthorizationRequest }, { revoke }]) {
      const { call, jobs, tx, errors } = lostBegin(connector, "request-1");
      tx.connection.count.mockResolvedValue(1);

      await expect(call()).rejects.toBeInstanceOf(IsolationError);
      // Nothing is left to remove, so the recorded job goes.
      expect(jobs.cancelIn).toHaveBeenCalledWith(tx, connectionCleanupJobKey(LEFTOVER_REQUEST));
      expect(errors()).toEqual([]);
    }
    expect(cancelAuthorizationRequest).not.toHaveBeenCalled();
    expect(revoke).not.toHaveBeenCalled();
  });

  it("keeps the backup job, removing nothing, when it cannot read who refers to the authorization", async () => {
    const cancelAuthorizationRequest = vi.fn(async () => undefined);
    const { call, jobs, tx } = lostBegin({ cancelAuthorizationRequest }, "request-1");
    tx.connection.count.mockRejectedValue(new Error("database unavailable"));

    await expect(call()).rejects.toBeInstanceOf(IsolationError);
    expect(cancelAuthorizationRequest).not.toHaveBeenCalled();
    expect(jobs.enqueue).toHaveBeenCalledWith(connectionCleanupJob(LEFTOVER_REQUEST));
    expect(jobs.cancelIn).not.toHaveBeenCalled();
  });

  it("hands a failed removal to its backup job and answers the lost race as before", async () => {
    const cancelAuthorizationRequest = vi.fn(async () => {
      throw new Error("provider unavailable");
    });
    const { call, jobs, errors, warnings } = lostBegin({ cancelAuthorizationRequest }, "request-1");

    await expect(call()).rejects.toBeInstanceOf(IsolationError);
    // Enqueued again with no run-at: the queue retries it now.
    expect(jobs.enqueue).toHaveBeenCalledWith(connectionCleanupJob(LEFTOVER_REQUEST));
    expect(jobs.cancelIn).not.toHaveBeenCalled();
    // A job has it, so nobody has to act: not an error.
    expect(warnings()).toEqual(["connections.begin leftover cleanup failed; retrying"]);
    expect(errors()).toEqual([]);
  });

  it("retries instead of skipping the revoke when the provider cannot be asked for the account", async () => {
    const revoke = vi.fn(async () => undefined);
    const resolveConnectedAccountId = vi.fn(async (): Promise<string | undefined> => {
      throw new Error("provider unavailable");
    });
    const unreachable = lostBegin({ revoke, resolveConnectedAccountId }, "request-1");

    await expect(unreachable.call()).rejects.toBeInstanceOf(IsolationError);
    expect(revoke).not.toHaveBeenCalled();
    expect(unreachable.jobs.enqueue).toHaveBeenCalledWith(connectionCleanupJob(LEFTOVER_REQUEST));
    expect(unreachable.jobs.cancelIn).not.toHaveBeenCalled();

    // The provider answering that it holds no such account is the normal outcome.
    resolveConnectedAccountId.mockResolvedValue(undefined);
    const absent = lostBegin({ revoke, resolveConnectedAccountId }, "request-1");
    await expect(absent.call()).rejects.toBeInstanceOf(IsolationError);
    expect(revoke).not.toHaveBeenCalled();
    expect(absent.jobs.enqueue).not.toHaveBeenCalled();
    expect(absent.jobs.cancelIn).toHaveBeenCalledWith(
      absent.tx,
      connectionCleanupJobKey(LEFTOVER_REQUEST),
    );
  });

  it("retries the unreferenced-account cleanup when its database read fails", async () => {
    const revokeUnreferencedAccounts = vi.fn(async () => undefined);
    const { call, jobs, tx, errors } = lostBegin({ revokeUnreferencedAccounts }, "gmail");
    tx.connection.findMany
      // begin's own lookup of rows to reuse
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error("database unavailable"));

    await expect(call()).rejects.toBeInstanceOf(IsolationError);
    expect(jobs.enqueueIn).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ name: "connection.cleanup", payload: LEFTOVER_APP }),
    );
    expect(revokeUnreferencedAccounts).not.toHaveBeenCalled();
    expect(jobs.enqueue).toHaveBeenCalledWith(connectionCleanupJob(LEFTOVER_APP));
    expect(jobs.cancelIn).not.toHaveBeenCalled();
    expect(errors()).toEqual([]);
  });

  it("keeps the backup job while a sibling's unfinished connection may own the accounts", async () => {
    const revokeUnreferencedAccounts = vi.fn(async () => undefined);
    const { call, jobs, tx, errors } = lostBegin({ revokeUnreferencedAccounts }, "gmail");
    tx.connection.findMany
      .mockResolvedValueOnce([])
      // A sibling that has not saved its account id yet.
      .mockResolvedValueOnce([{ providerRef: "account-1" }, { providerRef: "gmail" }]);

    await expect(call()).rejects.toBeInstanceOf(IsolationError);
    expect(revokeUnreferencedAccounts).not.toHaveBeenCalled();
    expect(jobs.cancelIn).not.toHaveBeenCalled();
    expect(jobs.enqueue).toHaveBeenLastCalledWith(
      expect.objectContaining({ payload: LEFTOVER_APP, availableAt: expect.any(Date) }),
    );
    expect(errors()).toEqual([]);
  });

  it("leaves a scope another flow holds to its backup job instead of waiting or failing", async () => {
    const revokeUnreferencedAccounts = vi.fn(async () => undefined);
    const { call, jobs, tx, errors } = lostBegin({ revokeUnreferencedAccounts }, "gmail");
    tx.$queryRaw.mockResolvedValue([{ locked: false }]);

    await expect(call()).rejects.toBeInstanceOf(IsolationError);
    expect(revokeUnreferencedAccounts).not.toHaveBeenCalled();
    expect(jobs.cancelIn).not.toHaveBeenCalled();
    expect(jobs.enqueue).toHaveBeenLastCalledWith(
      expect.objectContaining({ payload: LEFTOVER_APP, availableAt: expect.any(Date) }),
    );
    expect(errors()).toEqual([]);
  });

  it("starts a leftover app cleanup's time budget once it holds the scope", async () => {
    const budget = vi.spyOn(AbortSignal, "timeout");
    try {
      const revokeUnreferencedAccounts = vi.fn(async () => undefined);
      const { call, tx } = lostBegin({ revokeUnreferencedAccounts }, "gmail");

      await expect(call()).rejects.toBeInstanceOf(IsolationError);
      expect(revokeUnreferencedAccounts).toHaveBeenCalledTimes(1);
      expect(budget).toHaveBeenCalledTimes(1);
      expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
        budget.mock.invocationCallOrder[0]!,
      );
    } finally {
      budget.mockRestore();
    }
  });

  describe("when saving the result fails after the provider answered", () => {
    it("removes the authorization and still reports the failure", async () => {
      const cancelAuthorizationRequest = vi.fn(async () => undefined);
      const { call, jobs, tx, root } = lostBegin({ cancelAuthorizationRequest }, "request-1");
      // The lost race's job write fails, which fails its transaction.
      jobs.enqueueIn.mockRejectedValue(new Error("queue unavailable"));

      await expect(call()).rejects.toThrow("queue unavailable");
      // Recorded, removed, and only then is the record deleted.
      expect(jobs.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({ payload: LEFTOVER_REQUEST, availableAt: expect.any(Date) }),
      );
      expect(jobs.enqueue.mock.invocationCallOrder[0]).toBeLessThan(
        cancelAuthorizationRequest.mock.invocationCallOrder[0]!,
      );
      expect(cancelAuthorizationRequest).toHaveBeenCalledWith("request-1", expect.anything());
      expect(jobs.cancelIn).toHaveBeenCalledWith(tx, connectionCleanupJobKey(LEFTOVER_REQUEST));
      // The row is marked failed only while it is exactly what this begin first wrote, and
      // before the removal, which would otherwise wait for it as for a connection in flight.
      const { attempt } = tx.connection.create.mock.calls[0]![0].data.metadata;
      expect(root.updateMany).toHaveBeenCalledWith({
        where: expect.objectContaining({
          id: "conn-1",
          status: "pending",
          metadata: { equals: { attempt } },
        }),
        data: { status: "error" },
      });
      expect(root.updateMany.mock.invocationCallOrder[0]).toBeLessThan(
        tx.$queryRaw.mock.invocationCallOrder[0]!,
      );
    });

    it("hands the removal to a job when the provider cannot be reached either", async () => {
      const cancelAuthorizationRequest = vi.fn(async () => {
        throw new Error("provider unavailable");
      });
      const { call, jobs, tx, prisma } = lostBegin({ cancelAuthorizationRequest }, "request-1");
      // Begin's first transaction creates the row; the one that saves the result fails.
      const transaction = prisma.$transaction as unknown as ReturnType<typeof vi.fn>;
      transaction
        .mockImplementationOnce(async (fn: (client: unknown) => Promise<unknown>) => fn(tx))
        .mockRejectedValueOnce(new Error("Transaction already closed"));

      await expect(call()).rejects.toThrow("Transaction already closed");
      expect(cancelAuthorizationRequest).toHaveBeenCalledTimes(1);
      expect(jobs.enqueue).toHaveBeenLastCalledWith(connectionCleanupJob(LEFTOVER_REQUEST));
      expect(jobs.cancelIn).not.toHaveBeenCalled();
    });

    it("still removes the authorization when the queue cannot be reached, and says so if it cannot", async () => {
      const cancelAuthorizationRequest = vi.fn(async () => undefined);
      const reachable = lostBegin({ cancelAuthorizationRequest }, "request-1");
      reachable.jobs.enqueueIn.mockRejectedValue(new Error("queue unavailable"));
      reachable.jobs.enqueue.mockRejectedValue(new Error("queue unavailable"));

      await expect(reachable.call()).rejects.toThrow("queue unavailable");
      expect(cancelAuthorizationRequest).toHaveBeenCalledWith("request-1", expect.anything());
      expect(reachable.errors()).toEqual([]);

      // Neither the provider nor the queue: nothing will retry, so the log names what to remove.
      cancelAuthorizationRequest.mockRejectedValue(new Error("provider unavailable"));
      const unreachable = lostBegin({ cancelAuthorizationRequest }, "request-1");
      unreachable.jobs.enqueueIn.mockRejectedValue(new Error("queue unavailable"));
      unreachable.jobs.enqueue.mockRejectedValue(new Error("queue unavailable"));
      await expect(unreachable.call()).rejects.toThrow("queue unavailable");
      expect(unreachable.errors()).toEqual([
        "connections.begin leftover cleanup has no backup job; remove the authorization at the provider by hand",
      ]);
      expect(unreachable.events().at(-1)).toMatchObject({
        userId: "user-1",
        connectorId: "composio",
        provider: "gmail",
        providerRef: "request-1",
      });
    });

    it("leaves a result that was saved after all to its row", async () => {
      // The save committed without its answer arriving: the row holds the authorization.
      const cancelAuthorizationRequest = vi.fn(async () => undefined);
      const revoke = vi.fn(async () => undefined);
      for (const connector of [{ cancelAuthorizationRequest }, { revoke }]) {
        const { call, jobs, tx, errors } = lostBegin(connector, "request-1");
        jobs.enqueueIn.mockRejectedValue(new Error("connection lost at commit"));
        tx.connection.count.mockResolvedValue(1);

        await expect(call()).rejects.toThrow("connection lost at commit");
        // The removal reads the rows under the scope's lock, as the job would, and finds it in use.
        expect(tx.connection.count).toHaveBeenCalledWith({
          where: expect.objectContaining({ providerRef: "request-1" }),
        });
        expect(jobs.cancelIn).toHaveBeenCalledWith(tx, connectionCleanupJobKey(LEFTOVER_REQUEST));
        expect(errors()).toEqual([]);
      }
      expect(cancelAuthorizationRequest).not.toHaveBeenCalled();
      expect(revoke).not.toHaveBeenCalled();
    });

    it("removes nothing itself when it cannot read whether the result was saved", async () => {
      const cancelAuthorizationRequest = vi.fn(async () => undefined);
      const revoke = vi.fn(async () => undefined);
      for (const connector of [{ cancelAuthorizationRequest }, { revoke }]) {
        const { call, jobs, tx, errors } = lostBegin(connector, "request-1");
        jobs.enqueueIn.mockRejectedValue(new Error("connection lost at commit"));
        tx.connection.count.mockRejectedValue(new Error("database unavailable"));

        await expect(call()).rejects.toThrow("connection lost at commit");
        // The job decides later, under the lock, once it can read the row.
        expect(jobs.enqueue).toHaveBeenLastCalledWith(connectionCleanupJob(LEFTOVER_REQUEST));
        expect(jobs.cancelIn).not.toHaveBeenCalled();
        expect(errors()).toEqual([]);
      }
      expect(cancelAuthorizationRequest).not.toHaveBeenCalled();
      expect(revoke).not.toHaveBeenCalled();
    });

    it("leaves the authorization and names it when neither the database nor the queue answers", async () => {
      const cancelAuthorizationRequest = vi.fn(async () => undefined);
      const { call, jobs, tx, errors, events } = lostBegin(
        { cancelAuthorizationRequest },
        "request-1",
      );
      jobs.enqueueIn.mockRejectedValue(new Error("connection lost at commit"));
      jobs.enqueue.mockRejectedValue(new Error("queue unavailable"));
      tx.connection.count.mockRejectedValue(new Error("database unavailable"));

      await expect(call()).rejects.toThrow("connection lost at commit");
      // An authorization nothing may refer to is the lesser harm next to deleting one in use.
      expect(cancelAuthorizationRequest).not.toHaveBeenCalled();
      expect(errors()).toEqual([
        "connections.begin leftover cleanup has no backup job; remove the authorization at the provider by hand",
      ]);
      expect(events().at(-1)).toMatchObject({
        spaceId: "workspace-1",
        userId: "user-1",
        connectorId: "composio",
        provider: "gmail",
        providerRef: "request-1",
      });
    });

    it("still removes the authorization when its row cannot be marked failed", async () => {
      const cancelAuthorizationRequest = vi.fn(async () => undefined);
      const { call, jobs, root } = lostBegin({ cancelAuthorizationRequest }, "request-1");
      jobs.enqueueIn.mockRejectedValue(new Error("queue unavailable"));
      root.updateMany.mockRejectedValue(new Error("database unavailable"));

      await expect(call()).rejects.toThrow("queue unavailable");
      expect(cancelAuthorizationRequest).toHaveBeenCalledWith("request-1", expect.anything());
    });
  });

  it("leaves the job shared by an app's cleanups for the queue to run", async () => {
    // Every cleanup of an app's accounts in one scope shares a job key. Deleting the job after
    // this removal could take the record another begin made since the accounts were listed.
    const revokeUnreferencedAccounts = vi.fn(async () => undefined);
    const { call, jobs, tx, errors } = lostBegin({ revokeUnreferencedAccounts }, "gmail");

    await expect(call()).rejects.toBeInstanceOf(IsolationError);
    expect(revokeUnreferencedAccounts).toHaveBeenCalledTimes(1);
    expect(jobs.enqueueIn).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ payload: LEFTOVER_APP, availableAt: expect.any(Date) }),
    );
    expect(jobs.cancelIn).not.toHaveBeenCalled();
    expect(jobs.enqueue).not.toHaveBeenCalled();
    expect(errors()).toEqual([]);
  });

  it.each([
    [
      "with the connector auth code when the app has no usable sign-in",
      new ConnectorAuthUnavailableError({
        cause: '400 {"error":{"slug":"ToolRouterV2_NoManagedAuth"}}',
      }),
      400,
      { code: CONNECTOR_AUTH_UNAVAILABLE },
    ],
    [
      "as a fault, not the person's mistake, when the provider fails",
      new Error('502 {"error":"ToolRouterV2_NoManagedAuth upstream"}'),
      500,
      { code: "INTERNAL_SERVER_ERROR" },
    ],
  ])("answers %s", async (_case, failure, status, answer) => {
    const begin = vi.fn().mockRejectedValue(failure);
    const rootUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
    const tx = {
      $executeRaw: vi.fn().mockResolvedValue(undefined),
      connection: {
        findMany: vi.fn().mockResolvedValue([]),
        create: vi.fn().mockResolvedValue({ id: "conn-1", status: "pending" }),
      },
    };
    const prisma = {
      connection: { updateMany: rootUpdateMany },
      $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(tx)),
    } as unknown as PrismaClient;
    const handler = appHandler({
      prisma,
      connectors: { managed: vi.fn(() => ({ begin })) },
      env: {
        defaultProvider: "fake",
        defaultModel: "fake-model",
        webOrigin: "http://127.0.0.1:5173",
        screenProxySecret: "fake-test-secret",
        sandboxProvider: "fake",
      },
      dataDir: "/tmp/rakazo-router-test",
    } as unknown as RouterDeps);

    const response = await handle(
      handler,
      new Request("http://127.0.0.1/rpc/connections/begin", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          json: { connectorId: "composio", provider: "twitter", displayName: "Twitter" },
        }),
      }),
      {
        prefix: "/rpc",
        context: {
          actor: {
            spaceId: "workspace-1",
            userId: "user-1",
            email: "user@rakazo.test",
            isDeploymentOwner: true,
          },
        },
      },
    );

    expect(response.status).toBe(status);
    const body = await response.json();
    expect(body).toMatchObject({ json: answer });
    expect(JSON.stringify(body)).not.toContain("ToolRouterV2_NoManagedAuth");
    expect(rootUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: "error" } }),
    );
  });
});

describe("integration setup authorization", () => {
  it.each([
    { owner: false, configured: false, needsSetup: false },
    { owner: true, configured: false, needsSetup: false },
    { owner: true, configured: true, needsSetup: false },
  ])(
    "never offers server setup to an app account: %j",
    async ({ owner, configured, needsSetup }) => {
      const lookup = vi.fn(async () => configured);
      const deps = {
        prisma: {},
        env: { webOrigin: "https://example.test" },
        integrationSettings: { configured: lookup },
      } as unknown as RouterDeps;
      const handler = new RPCHandler(createRouter(deps));
      const response = await handle(
        handler,
        new Request("https://example.test/rpc/integrationSetup/get", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ json: null }),
        }),
        {
          prefix: "/rpc",
          context: {
            actor: {
              userId: "user",
              spaceId: "space",
              email: "user@rakazo.test",
              isDeploymentOwner: owner,
            },
          },
        },
      );
      const result = (await response.json()).json;
      expect(result).toMatchObject({ canConfigure: false, needsSetup });
      expect(result.providers).toEqual([]);
      expect(lookup).not.toHaveBeenCalled();
    },
  );

  it("rejects provider credentials from a non-owner before verification or persistence", async () => {
    const save = vi.fn();
    const deps = {
      prisma: {},
      env: { webOrigin: "https://example.test" },
      integrationSettings: { save },
    } as unknown as RouterDeps;
    const handler = new RPCHandler(createRouter(deps));
    const response = await handle(
      handler,
      new Request("https://example.test/rpc/integrationSetup/save", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: { provider: "composio", apiKey: "fake-key" } }),
      }),
      {
        prefix: "/rpc",
        context: {
          actor: {
            userId: "member",
            spaceId: "space",
            email: "member@rakazo.test",
            isDeploymentOwner: false,
          },
        },
      },
    );
    expect(response.status).toBe(403);
    expect(save).not.toHaveBeenCalled();
  });
});

describe("connection tool listing", () => {
  it.each([true, false])("selects app catalog when available: %s", async (hasCatalog) => {
    const findMany = vi.fn(async () => [
      {
        id: "connection-1",
        displayName: "Example",
        providerRef: "account-1",
      },
    ]);
    const tools = [{ name: "example_action", description: "An action" }];
    const listAppTools = vi.fn(async () => tools);
    const discoverTools = vi.fn(async () => tools);
    const connector = { discoverTools, ...(hasCatalog ? { listAppTools } : {}) };
    const client = createRouterClient(
      createRouter({
        prisma: { connection: { findMany } },
        connectors: { managed: () => connector },
      } as unknown as RouterDeps),
      {
        context: { actor: { spaceId: "workspace-1", userId: "user-1" } } as never,
      },
    );
    expect(await client.connections.tools({ connectorId: "example", provider: "example" })).toEqual(
      [{ ...tools[0], approvalKey: "example_action" }],
    );
    expect(findMany).toHaveBeenCalledWith({
      where: {
        spaceId: "workspace-1",
        userId: "user-1",
        connectorId: "example",
        provider: "example",
        status: "connected",
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    if (hasCatalog) {
      expect(listAppTools).toHaveBeenCalledWith(expect.anything(), "example");
      expect(discoverTools).not.toHaveBeenCalled();
    } else {
      expect(discoverTools).toHaveBeenCalledWith(
        expect.objectContaining({
          connectedConnections: [
            {
              id: "connection-1",
              connectorId: "example",
              externalId: "example",
              displayName: "Example",
              providerRef: "account-1",
            },
          ],
          connectedProviders: ["example"],
        }),
      );
    }
  });

  it("lists a shared app tool once when the catalog returns it for multiple accounts", async () => {
    const route = {
      connectorId: "example",
      resourceId: "mail",
      toolName: "send_email",
    };
    const listAppTools = vi.fn(async ({ connectedConnections }) =>
      connectedConnections.flatMap(({ id }: { id: string }) => [
        {
          name: `send_email_${id}`,
          description: "Send an email",
          route: { ...route, connectionId: id },
        },
        ...(id === "connection-2"
          ? [
              {
                name: "export_mail",
                description: "Export mail",
                route: { ...route, toolName: "export_mail", connectionId: id },
              },
            ]
          : []),
      ]),
    );
    const client = createRouterClient(
      createRouter({
        prisma: {
          connection: { findMany: async () => [{ id: "connection-1" }, { id: "connection-2" }] },
        },
        connectors: { managed: () => ({ listAppTools }) },
      } as unknown as RouterDeps),
      { context: { actor: { spaceId: "workspace-1", userId: "user-1" } as never } },
    );

    expect(await client.connections.tools({ connectorId: "example", provider: "mail" })).toEqual([
      {
        name: "send_email",
        description: "Send an email",
        approvalKey: 'app-tool/["example","mail","send_email"]',
      },
      {
        name: "export_mail",
        description: "Export mail",
        approvalKey: 'app-tool/["example","mail","export_mail"]',
      },
    ]);
  });

  it("retains a write declaration when accounts disagree on a shared tool", async () => {
    const listAppTools = vi.fn(async ({ connectedConnections }) =>
      connectedConnections.map(({ id }: { id: string }) => ({
        name: `list_messages_${id}`,
        description: "List messages",
        readOnly: id === "connection-1",
        route: {
          connectorId: "example",
          resourceId: "mail",
          toolName: "list_messages",
          connectionId: id,
        },
      })),
    );
    const client = createRouterClient(
      createRouter({
        prisma: {
          connection: { findMany: async () => [{ id: "connection-1" }, { id: "connection-2" }] },
        },
        connectors: { managed: () => ({ listAppTools }) },
      } as unknown as RouterDeps),
      { context: { actor: { spaceId: "workspace-1", userId: "user-1" } as never } },
    );

    expect(await client.connections.tools({ connectorId: "example", provider: "mail" })).toEqual([
      {
        name: "list_messages",
        description: "List messages",
        readOnly: false,
        approvalKey: 'app-tool/["example","mail","list_messages"]',
      },
    ]);
  });

  it("returns an RPC error when the app tool catalog fails to load", async () => {
    const handler = new RPCHandler(
      createRouter({
        prisma: { connection: { findMany: async () => [{ id: "connection-1" }] } },
        connectors: {
          managed: () => ({
            listAppTools: vi.fn().mockRejectedValue(new Error("Upstream catalog unavailable")),
          }),
        },
      } as unknown as RouterDeps),
    );
    const response = await handle(
      handler,
      new Request("https://example.test/rpc/connections/tools", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: { connectorId: "example", provider: "example" } }),
      }),
      {
        prefix: "/rpc",
        context: { actor: { spaceId: "workspace-1", userId: "user-1" } as Actor },
      },
    );
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("Upstream catalog unavailable");
  });

  it("does not report a listing the client cancelled", async () => {
    const sink = createTestSink();
    installLogger(createLogger({ service: "rakazo-api", sinks: [sink] }));
    const controller = new AbortController();
    const listAppTools = vi.fn(async () => {
      controller.abort();
      throw new Error("Request was aborted.");
    });
    const client = createRouterClient(
      createRouter({
        prisma: { connection: { findMany: async () => [{ id: "connection-1" }] } },
        connectors: { managed: () => ({ discoverTools: vi.fn(), listAppTools }) },
      } as unknown as RouterDeps),
      {
        context: {
          actor: { spaceId: "workspace-1", userId: "user-1" },
          signal: controller.signal,
        } as never,
      },
    );
    expect(await client.connections.tools({ connectorId: "example", provider: "example" })).toEqual(
      [],
    );
    expect(listAppTools).toHaveBeenCalled();
    expect(sink.events.filter((event) => event.level === "error")).toEqual([]);
    expect(sink.events).toContainEqual(
      expect.objectContaining({ level: "warn", message: "connections.tools cancelled" }),
    );
  });
});
