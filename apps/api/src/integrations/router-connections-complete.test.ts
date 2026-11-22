import { createRouterClient } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import type { BackgroundJob, ManagedConnectorProvider } from "@rakazo/adapter-kit";
import { connectionCleanupJob } from "@rakazo/adapter-kit";
import {
  EncryptedSecretStore,
  IntegrationProviderSettings,
  providerScopeKey,
} from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import { deferred } from "@rakazo/core/test-async";
import type { PrismaClient } from "@rakazo/db";
import { configureProviderTransactionPool, runProviderTransaction } from "@rakazo/db";
import { createLogger, createTestSink, installLogger } from "@rakazo/logging";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "../router.js";
import { createRouter, handle } from "../router-test-support.js";

const markAppConnected = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../account/onboarding.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  markAppConnected,
}));

describe("connections.complete", () => {
  beforeEach(() => markAppConnected.mockClear());
  it.each([
    ["complete", false],
    ["complete", true],
    ["revoke", false],
    ["revoke", true],
  ] as const)(
    "prepares slow configured credentials for %s (changed: %s)",
    async (operation, changed) => {
      const secrets = new EncryptedSecretStore("test-encryption-key");
      const stored = await secrets.put(
        JSON.stringify({ provider: "composio", apiKey: "fake-key" }),
        {
          operationId: "test",
          traceId: "test",
          spaceId: "workspace-1",
          userId: "user-1",
          signal: new AbortController().signal,
        },
        { recordId: "integration-provider:composio" },
      );
      let ref = stored.ref;
      let inTransaction = false;
      let elapsed = 0;
      const originalLoad = EncryptedSecretStore.prototype.load.bind(secrets);
      const load = vi.spyOn(secrets, "load").mockImplementation(async (...args) => {
        expect(inTransaction).toBe(false);
        elapsed += 15_000;
        return originalLoad(...args);
      });
      const row = {
        id: "conn-1",
        connectorId: "composio",
        provider: "gmail",
        providerRef: "gmail",
        displayName: "Gmail",
        status: "pending",
        createdAt: new Date(0),
      };
      const client = {
        integrationProviderConfig: {
          findUnique: vi.fn(async () => ({ id: "composio", ciphertext: ref })),
        },
        connection: {
          findFirst: vi.fn(async () => row),
          findMany: vi.fn(async () => []),
          count: vi.fn(async () => 0),
          updateMany: vi.fn(async () => ({ count: 1 })),
        },
        $executeRaw: vi.fn(),
        $queryRaw: vi.fn(async () => [{ locked: true }]),
      };
      const prisma = {
        ...client,
        $transaction: vi.fn(async (fn: (tx: typeof client) => Promise<unknown>) => {
          const started = elapsed;
          if (changed) ref = "replacement-ref";
          inTransaction = true;
          try {
            const result = await fn(client);
            expect(elapsed - started).toBeLessThan(5_000);
            return result;
          } finally {
            inTransaction = false;
          }
        }),
      };
      const complete = vi.fn(async () => ({ connectionRef: "gmail" }));
      const revoke = vi.fn(async () => undefined);
      const adapter = {
        complete,
        revoke,
        connectionReady: vi.fn(async () => false),
      } as unknown as ManagedConnectorProvider;
      const settings = new IntegrationProviderSettings(
        prisma as unknown as PrismaClient,
        secrets,
        "fake-identity",
        {},
        () => adapter,
      );
      const connector = settings
        .providers()
        .find((provider) => provider.describe().id === "composio");
      const handler = new RPCHandler(
        createRouter({
          prisma,
          connectors: { managed: () => connector },
          env: {
            defaultProvider: "fake",
            defaultModel: "fake-model",
            webOrigin: "http://127.0.0.1:5173",
            screenProxySecret: "fake-test-secret",
            sandboxProvider: "fake",
          },
        } as unknown as RouterDeps),
      );
      const response = await handle(
        handler,
        new Request(`http://127.0.0.1/rpc/connections/${operation}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            json: {
              connectionId: row.id,
              ...(operation === "complete" ? { code: "fake-code" } : {}),
            },
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
      expect(response.status).toBe(changed ? 409 : 200);
      expect(elapsed).toBe(15_000);
      expect(load).toHaveBeenCalledTimes(1);
      expect(operation === "complete" ? complete : revoke).toHaveBeenCalledTimes(changed ? 0 : 1);
    },
  );

  it("forwards an optional code to the managed connector", async () => {
    const complete = vi.fn().mockResolvedValue({ connectionRef: "gmail" });
    const connectionReady = vi.fn().mockResolvedValue(true);
    const update = vi.fn().mockResolvedValue({
      id: "conn-1",
      connectorId: "composio",
      provider: "gmail",
      displayName: "Gmail",
      status: "connected",
      createdAt: new Date("2026-08-26T00:00:00.000Z"),
    });
    const prisma = {
      connection: {
        findFirst: vi.fn().mockResolvedValue({
          id: "conn-1",
          connectorId: "composio",
          provider: "gmail",
          displayName: "Gmail",
          providerRef: "gmail-state",
          status: "pending",
          createdAt: new Date("2026-08-26T00:00:00.000Z"),
        }),
        findMany: vi.fn().mockResolvedValue([]),
        update,
      },
      $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
        const row = {
          id: "conn-1",
          connectorId: "composio",
          provider: "gmail",
          displayName: "Gmail",
          providerRef: "gmail-state",
          status: "pending",
          createdAt: new Date("2026-08-26T00:00:00.000Z"),
        };
        const tx = {
          $executeRaw: vi.fn().mockResolvedValue(undefined),
          $queryRaw: vi.fn().mockResolvedValue([{ locked: true }]),
          connection: {
            findFirst: vi
              .fn()
              .mockResolvedValueOnce(row)
              .mockResolvedValueOnce(null)
              .mockResolvedValueOnce({ ...row, status: "connected" }),
            findMany: vi.fn().mockResolvedValue([]),
            updateMany: vi.fn().mockResolvedValue({ count: 1 }),
          },
        };
        return fn(tx);
      }),
    } as unknown as PrismaClient;
    const deps = {
      prisma,
      connectors: {
        managed: vi.fn(() => ({ complete, connectionReady })),
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
      new Request("http://127.0.0.1/rpc/connections/complete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          json: {
            connectionId: "conn-1",
            code: "123456",
          },
        }),
      }),
      { prefix: "/rpc", context: { actor } },
    );

    expect(response.status).toBe(200);
    expect(complete).toHaveBeenCalledWith(
      { state: "gmail-state", code: "123456" },
      expect.objectContaining({ spaceId: "workspace-1", userId: "user-1" }),
    );
    expect(connectionReady).toHaveBeenCalled();
  });

  it.each(["lock", "slot"] as const)(
    "reports the row as pending without a provider call while another call holds the %s",
    async (held) => {
      vi.useFakeTimers();
      const row = {
        id: "conn-1",
        connectorId: "composio",
        provider: "gmail",
        displayName: "Gmail",
        providerRef: "gmail-state",
        status: "pending",
        createdAt: new Date("2026-08-26T00:00:00.000Z"),
      };
      const connectionReady = vi.fn().mockResolvedValue(true);
      const tx = {
        $queryRaw: vi.fn().mockResolvedValue([{ locked: false }]),
        connection: { findFirst: vi.fn().mockResolvedValue(row) },
      };
      const prisma = {
        connection: { findFirst: vi.fn().mockResolvedValue(row) },
        $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(tx)),
      } as unknown as PrismaClient;
      const handler = new RPCHandler(
        createRouter({
          prisma,
          connectors: { managed: vi.fn(() => ({ connectionReady })) },
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
      const slot = deferred();
      const holder =
        held === "slot"
          ? runProviderTransaction(
              providerScopeKey({ spaceId: "workspace-1", userId: "user-1" }, "composio", "gmail"),
              () => slot.promise,
              60_000,
            )
          : Promise.resolve();
      try {
        const handled = handle(
          handler,
          new Request("http://127.0.0.1/rpc/connections/complete", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ json: { connectionId: "conn-1" } }),
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
        await vi.advanceTimersByTimeAsync(2_000);
        const response = await handled;

        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ json: { id: "conn-1", status: "pending" } });
        expect(connectionReady).not.toHaveBeenCalled();
        expect(prisma.$transaction).toHaveBeenCalledTimes(held === "lock" ? 1 : 0);
      } finally {
        slot.resolve();
        await holder;
        vi.useRealTimers();
      }
    },
  );

  it("completes another space's integration while a slow provider call holds its own scope", async () => {
    vi.useFakeTimers();
    // The API sizes the gate from its pool when it builds the app; the default pool is 4.
    configureProviderTransactionPool(4);
    const slowRow = {
      id: "conn-slow",
      spaceId: "space-1",
      userId: "user-1",
      connectorId: "composio",
      provider: "gmail",
      displayName: "Gmail",
      providerRef: "gmail-state",
      status: "pending",
      createdAt: new Date("2026-08-26T00:00:00.000Z"),
    };
    const otherRow = {
      id: "conn-other",
      spaceId: "space-2",
      userId: "user-2",
      connectorId: "pipedream",
      provider: "slack",
      displayName: "Slack",
      providerRef: "slack-account",
      status: "pending",
      createdAt: new Date("2026-08-26T00:00:00.000Z"),
    };
    const slowProvider = deferred<boolean>();
    const releaseSlowProvider = () => slowProvider.resolve(true);
    const otherReady = vi.fn().mockResolvedValue(true);
    const connectors = {
      managed: vi.fn((id: string) =>
        id === "composio"
          ? { connectionReady: () => slowProvider.promise }
          : { connectionReady: otherReady },
      ),
    };
    // Each transaction reads its row, probes whether the providerRef is taken, then
    // re-reads after the update; dispatch on the probe's providerRef and per-space reads.
    const readsBySpace = new Map<string, number>();
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ locked: true }]),
      connection: {
        findFirst: vi.fn(
          async ({ where }: { where: { spaceId?: string; providerRef?: string } }) => {
            if (where.providerRef) return null;
            const reads = (readsBySpace.get(where.spaceId ?? "") ?? 0) + 1;
            readsBySpace.set(where.spaceId ?? "", reads);
            const row = where.spaceId === "space-1" ? slowRow : otherRow;
            return reads === 1 ? { ...row } : { ...row, status: "connected" };
          },
        ),
        findMany: vi.fn().mockResolvedValue([]),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const prisma = {
      connection: {
        findFirst: vi.fn(async ({ where }: { where: { id: string } }) =>
          where.id === slowRow.id ? { ...slowRow } : { ...otherRow },
        ),
      },
      $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(tx)),
    } as unknown as PrismaClient;
    const handler = new RPCHandler(
      createRouter({
        prisma,
        connectors,
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
    const completeRequest = (connectionId: string, spaceId: string, userId: string) =>
      handle(
        handler,
        new Request("http://127.0.0.1/rpc/connections/complete", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ json: { connectionId } }),
        }),
        {
          prefix: "/rpc",
          context: {
            actor: { spaceId, userId, email: `${userId}@rakazo.test`, isDeploymentOwner: true },
          },
        },
      );
    try {
      // A hanging provider call inside space-1's gated transaction pins its scope.
      const slowHandled = completeRequest(slowRow.id, "space-1", "user-1");
      await vi.advanceTimersByTimeAsync(0);
      const otherHandled = completeRequest(otherRow.id, "space-2", "user-2");
      await vi.advanceTimersByTimeAsync(2_000);
      const response = await otherHandled;

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        json: { id: "conn-other", status: "connected" },
      });
      expect(otherReady).toHaveBeenCalledWith(expect.anything(), "slack");

      releaseSlowProvider();
      const slowResponse = await slowHandled;
      expect(slowResponse.status).toBe(200);
    } finally {
      releaseSlowProvider();
      vi.useRealTimers();
    }
  });

  afterEach(() => {
    installLogger(createLogger({ service: "rakazo-api", level: "off", sinks: [] }));
  });

  function pollFixture(status: string, metadata?: unknown) {
    const row = {
      metadata,
      id: "conn-1",
      spaceId: "workspace-1",
      userId: "user-1",
      connectorId: "composio",
      provider: "gmail",
      displayName: "Gmail",
      providerRef: "gmail",
      status,
      createdAt: new Date("2026-08-26T00:00:00.000Z"),
    };
    const connection = {
      findFirst: vi.fn(async ({ where }: { where: { id: string } }) =>
        where.id === row.id ? { ...row } : null,
      ),
      findMany: vi.fn(async () => []),
      count: vi.fn(async () => 0),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { status?: string | { in: string[] } };
          data: Partial<typeof row>;
        }) => {
          const statuses = typeof where.status === "string" ? [where.status] : where.status?.in;
          if (statuses && !statuses.includes(row.status)) return { count: 0 };
          Object.assign(row, data);
          return { count: 1 };
        },
      ),
    };
    const client = {
      connection,
      $executeRaw: vi.fn(async () => undefined),
      $queryRaw: vi.fn(async () => [{ locked: true }]),
    };
    const transaction = { open: false };
    const prisma = {
      ...client,
      // A transaction that rejects leaves the row as it found it.
      $transaction: vi.fn(async (fn: (tx: typeof client) => Promise<unknown>) => {
        const before = { ...row };
        transaction.open = true;
        try {
          return await fn(client);
        } catch (error) {
          Object.assign(row, before);
          throw error;
        } finally {
          transaction.open = false;
        }
      }),
    } as unknown as PrismaClient;
    const connector = {
      complete: vi.fn(),
      revoke: vi.fn(),
      connectionReady: vi.fn(async () => true),
    };
    const jobs = {
      enqueue: vi.fn(async (_job: BackgroundJob) => undefined),
      enqueueIn: vi.fn(async (_tx: unknown, _job: BackgroundJob) => undefined),
    };
    const analytics = { capture: vi.fn(), flush: vi.fn() };
    const handler = new RPCHandler(
      createRouter({
        prisma,
        jobs,
        analytics,
        connectors: { managed: () => connector },
        env: {
          defaultProvider: "fake",
          defaultModel: "fake-model",
          webOrigin: "http://127.0.0.1:5173",
          screenProxySecret: "fake-test-secret",
          sandboxProvider: "fake",
        },
      } as unknown as RouterDeps),
    );
    const sink = createTestSink();
    installLogger(createLogger({ service: "rakazo-api", sinks: [sink] }));
    async function complete(connectionId = row.id, signal?: AbortSignal) {
      return call("complete", connectionId, signal);
    }
    async function revoke(signal?: AbortSignal) {
      return call("revoke", row.id, signal);
    }
    async function call(operation: string, connectionId: string, signal?: AbortSignal) {
      const response = await handle(
        handler,
        new Request(`http://127.0.0.1/rpc/connections/${operation}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ json: { connectionId } }),
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
            signal,
          },
        },
      );
      return { status: response.status, body: await response.json() };
    }
    const securityEvents = () => sink.events.filter((event) => event.message === "security.event");
    return {
      complete,
      revoke,
      connector,
      connection,
      client,
      jobs,
      securityEvents,
      analytics,
      row,
      sink,
      transaction,
    };
  }

  const ACCOUNT_CLEANUP = {
    spaceId: "workspace-1",
    userId: "user-1",
    connectorId: "composio",
    provider: "gmail",
    ref: "account-1",
  };

  it.each([
    ["the caller cancelled", true],
    ["an uncertain remote failure", false],
  ])(
    "keeps the row revoked after %s, with a job to finish the removal",
    async (_case, cancelled) => {
      const { revoke, connector, row, sink, jobs, client } = pollFixture("connected");
      row.providerRef = "account-1";
      const request = new AbortController();
      connector.revoke.mockImplementation(async () => {
        if (cancelled) request.abort();
        throw new Error("Request was cancelled by the caller: Request was aborted.");
      });

      await expect(revoke(request.signal)).resolves.toMatchObject({ status: 500 });
      expect(row.status).toBe("revoked");
      // A job has the removal, so nobody has to act: not an error.
      expect(
        sink.events
          .filter((event) => event.message.startsWith("connections.revoke"))
          .map((event) => event.level),
      ).toEqual(["warn"]);
      // No row can remove the account any more, so the job that does commits with the revoked row.
      expect(jobs.enqueueIn).toHaveBeenCalledWith(client, connectionCleanupJob(ACCOUNT_CLEANUP));
      expect(jobs.enqueue).not.toHaveBeenCalled();
    },
  );

  it("removes the account inside the transaction that revokes the row", async () => {
    // A process that dies around the provider call rolls the row back, so it stays the record.
    const { revoke, connector, row, jobs, transaction } = pollFixture("connected");
    row.providerRef = "account-1";
    connector.revoke.mockImplementation(async () => {
      expect(transaction.open).toBe(true);
      expect(row.status).toBe("revoked");
    });

    await expect(revoke()).resolves.toMatchObject({ status: 200 });
    expect(connector.revoke).toHaveBeenCalledWith("account-1", expect.anything());
    expect(row.status).toBe("revoked");
    expect(jobs.enqueueIn).not.toHaveBeenCalled();
    expect(jobs.enqueue).not.toHaveBeenCalled();
  });

  it("does not start the provider call when waiting for the lock used up its time", async () => {
    const { revoke, connector, connection, row, jobs } = pollFixture("connected");
    row.providerRef = "account-1";
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      // The transaction has run for 50 of its 60 seconds by the time the call would start.
      connection.count.mockImplementation((async () => {
        vi.setSystemTime(Date.now() + 50_000);
        return 0;
      }) as never);

      expect((await revoke()).status).not.toBe(200);
    } finally {
      vi.useRealTimers();
    }
    expect(connector.revoke).not.toHaveBeenCalled();
    expect(row.status).toBe("connected");
    expect(jobs.enqueueIn).not.toHaveBeenCalled();
  });

  it("keeps the row as it was when the provider clearly removed nothing", async () => {
    const { revoke, connector, row, jobs } = pollFixture("connected");
    row.providerRef = "account-1";
    connector.revoke.mockRejectedValue(new Error("403 forbidden"));

    // The provider's refusal is a fault here, not the person's mistake.
    await expect(revoke()).resolves.toMatchObject({ status: 500 });
    // Still connected, so removing it again is how the authorization goes.
    expect(row.status).toBe("connected");
    expect(jobs.enqueueIn).not.toHaveBeenCalled();
    expect(jobs.enqueue).not.toHaveBeenCalled();
  });

  it("keeps the row when an uncertain removal's job cannot be recorded", async () => {
    const { revoke, connector, row, jobs } = pollFixture("connected");
    row.providerRef = "account-1";
    connector.revoke.mockRejectedValue(new Error("fetch failed"));
    jobs.enqueueIn.mockRejectedValue(new Error("queue unavailable"));

    expect((await revoke()).status).not.toBe(200);
    expect(row.status).toBe("connected");
  });

  it("leaves the account at the provider while another active row has saved it", async () => {
    const { revoke, connector, connection, row, jobs } = pollFixture("connected");
    row.providerRef = "account-1";
    connection.count.mockImplementation((async ({ where }: { where: { providerRef?: string } }) =>
      where.providerRef === "account-1" ? 1 : 0) as never);

    await expect(revoke()).resolves.toMatchObject({ status: 200 });
    expect(connection.count).toHaveBeenCalledWith({
      where: expect.objectContaining({
        providerRef: "account-1",
        status: { in: ["connected", "pending", "error"] },
      }),
    });
    expect(row.status).toBe("revoked");
    expect(connector.revoke).not.toHaveBeenCalled();
    expect(jobs.enqueueIn).not.toHaveBeenCalled();
  });

  it("records nothing but keeps the account id when the catalog connected the row first", async () => {
    const { complete, connector, securityEvents, row } = pollFixture("pending");
    // The catalog flips the row while complete is checking with the provider.
    connector.connectionReady.mockImplementation(async () => {
      row.status = "connected";
      return true;
    });
    Object.assign(connector, { resolveConnectedAccountId: vi.fn(async () => "account-1") });

    await expect(complete()).resolves.toMatchObject({ body: { json: { status: "connected" } } });
    expect(row.providerRef).toBe("account-1");
    expect(securityEvents()).toEqual([]);
  });

  it("stores the account id on a poll after the catalog connected the row", async () => {
    const { complete, connector, securityEvents, row } = pollFixture("connected");
    Object.assign(connector, { resolveConnectedAccountId: vi.fn(async () => "account-1") });

    await expect(complete()).resolves.toMatchObject({ body: { json: { status: "connected" } } });
    expect(row.providerRef).toBe("account-1");
    expect(connector.complete).not.toHaveBeenCalled();
    expect(securityEvents()).toEqual([]);
  });

  it("keeps the app-only ref while a sibling authorization for the same app is unresolved", async () => {
    const { complete, connector, connection, row } = pollFixture("connected");
    connection.findMany.mockResolvedValue([{ providerRef: "gmail", status: "pending" }] as never);
    Object.assign(connector, { resolveConnectedAccountId: vi.fn(async () => "account-2") });

    await expect(complete()).resolves.toMatchObject({ body: { json: { status: "connected" } } });
    expect(row.providerRef).toBe("gmail");
  });

  it("stores the account id beside an abandoned sibling attempt", async () => {
    const { complete, connector, connection, row } = pollFixture("connected");
    connection.findMany.mockResolvedValue([{ providerRef: null, status: "error" }] as never);
    Object.assign(connector, { resolveConnectedAccountId: vi.fn(async () => "account-1") });

    await expect(complete()).resolves.toMatchObject({ body: { json: { status: "connected" } } });
    expect(row.providerRef).toBe("account-1");
  });

  it("stores the connected account a request id resolves to", async () => {
    const { complete, connector, row } = pollFixture("pending");
    row.providerRef = "request-1";
    Object.assign(connector, {
      accounts: new Map([["request-1", "account-1"]]),
      async resolveConnectedAccountId(
        this: { accounts: Map<string, string> },
        _userId: string,
        _slug: string,
        ref: string,
      ) {
        return this.accounts.get(ref);
      },
    });

    await expect(complete()).resolves.toMatchObject({ body: { json: { status: "connected" } } });
    expect(row.providerRef).toBe("account-1");
  });

  it("connects a retry's own sign-in while an abandoned earlier attempt stays pending", async () => {
    const { complete, connector, connection, row } = pollFixture("pending");
    row.providerRef = "request-2";
    connection.findMany.mockResolvedValue([
      { providerRef: "request-1", status: "pending" },
    ] as never);
    const resolveConnectedAccountId = vi.fn(async (_userId: string, _slug: string, ref: string) =>
      ref === "request-2" ? "account-2" : undefined,
    );
    Object.assign(connector, { resolveConnectedAccountId });

    await expect(complete()).resolves.toMatchObject({ body: { json: { status: "connected" } } });
    expect(row.providerRef).toBe("account-2");
    expect(resolveConnectedAccountId).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "request-1",
      expect.anything(),
      expect.anything(),
    );
  });

  it("leaves the row for the next poll when the provider cannot be asked for the account", async () => {
    const { complete, connector, row, sink } = pollFixture("pending");
    const resolveConnectedAccountId = vi.fn(async (): Promise<string | undefined> => {
      throw new Error("provider unavailable");
    });
    Object.assign(connector, { resolveConnectedAccountId });

    await expect(complete()).resolves.toMatchObject({
      status: 200,
      body: { json: { status: "pending" } },
    });
    expect(row).toMatchObject({ status: "pending", providerRef: "gmail" });
    // A warning: an outage repeats it on every poll, and the next poll asks again.
    expect(sink.events.filter((event) => event.level === "error")).toEqual([]);
    expect(sink.events.filter((event) => event.level === "warn")).toEqual([
      expect.objectContaining({
        message: "connections.complete could not resolve the connected account",
        connectionId: "conn-1",
      }),
    ]);

    resolveConnectedAccountId.mockResolvedValue("account-1");
    await expect(complete()).resolves.toMatchObject({ body: { json: { status: "connected" } } });
    expect(row.providerRef).toBe("account-1");
  });

  const REQUEST_CLEANUP = { ...ACCOUNT_CLEANUP, ref: "request-1" };
  const { ref: _account, ...APP_CLEANUP } = ACCOUNT_CLEANUP;

  it("records a job when a superseded row's authorization cannot be removed", async () => {
    const { complete, connector, row, sink, jobs } = pollFixture("revoked");
    row.providerRef = "request-1";
    Object.assign(connector, {
      resolveConnectedAccountId: vi.fn(async () => {
        throw new Error("provider unavailable");
      }),
    });

    // Still revoked, and reported so, which ends the polling: the job has the removal now.
    await expect(complete()).resolves.toMatchObject({
      status: 200,
      body: { json: { status: "revoked" } },
    });
    expect(row.status).toBe("revoked");
    expect(connector.revoke).not.toHaveBeenCalled();
    expect(jobs.enqueue).toHaveBeenCalledWith(connectionCleanupJob(REQUEST_CLEANUP));
    expect(sink.events.filter((event) => event.level === "error")).toEqual([]);
    expect(sink.events.filter((event) => event.level === "warn")).toEqual([
      expect.objectContaining({
        message: "connections.complete remote cleanup failed for revoked row",
      }),
    ]);
  });

  it("records a job when a superseded row's unreferenced accounts cannot be removed", async () => {
    const { complete, connector, row, jobs } = pollFixture("revoked");
    Object.assign(connector, {
      revokeUnreferencedAccounts: vi.fn(async () => {
        throw new Error("provider unavailable");
      }),
    });

    await expect(complete()).resolves.toMatchObject({ body: { json: { status: "revoked" } } });
    expect(row.status).toBe("revoked");
    expect(jobs.enqueue).toHaveBeenCalledWith(connectionCleanupJob(APP_CLEANUP));
  });

  it("names what to remove by hand when a superseded row's failed removal cannot be recorded", async () => {
    const { complete, connector, row, sink, jobs } = pollFixture("revoked");
    row.providerRef = "request-1";
    connector.revoke.mockRejectedValue(new Error("provider unavailable"));
    jobs.enqueue.mockRejectedValue(new Error("queue unavailable"));

    // Reported as a failure, so the next poll tries the removal again.
    expect((await complete()).status).not.toBe(200);
    expect(row.status).toBe("revoked");
    expect(sink.events.filter((event) => event.level === "error")).toEqual([
      expect.objectContaining({
        message:
          "connections.complete could not record its cleanup; remove the authorization at the provider by hand",
        connectionId: "conn-1",
        providerRef: "request-1",
      }),
    ]);
  });

  it("leaves a superseded row's account alone once an active row has saved it", async () => {
    const { complete, connector, connection, row, jobs } = pollFixture("revoked");
    row.providerRef = "account-1";
    connection.count.mockResolvedValue(1 as never);

    await expect(complete()).resolves.toMatchObject({ body: { json: { status: "revoked" } } });
    expect(connection.count).toHaveBeenCalledWith({
      where: expect.objectContaining({
        providerRef: "account-1",
        status: { in: ["connected", "pending", "error"] },
      }),
    });
    expect(connector.revoke).not.toHaveBeenCalled();
    expect(jobs.enqueue).not.toHaveBeenCalled();
  });

  it("records a cleanup job when a superseded row's accounts cannot be told apart yet", async () => {
    const { complete, connector, connection, jobs, client } = pollFixture("revoked");
    const revokeUnreferencedAccounts = vi.fn(async () => undefined);
    Object.assign(connector, { revokeUnreferencedAccounts });
    // A sibling is still connecting and has only the app's name for a reference.
    connection.findMany.mockResolvedValue([{ providerRef: "gmail" }] as never);

    await expect(complete()).resolves.toMatchObject({ body: { json: { status: "revoked" } } });
    expect(revokeUnreferencedAccounts).not.toHaveBeenCalled();
    expect(jobs.enqueueIn).toHaveBeenCalledWith(
      client,
      expect.objectContaining({
        name: "connection.cleanup",
        payload: {
          spaceId: "workspace-1",
          userId: "user-1",
          connectorId: "composio",
          provider: "gmail",
        },
        availableAt: expect.any(Date),
      }),
    );

    // With every sibling's account known, the poll removes the rest itself and records nothing.
    jobs.enqueueIn.mockClear();
    connection.findMany.mockResolvedValue([{ providerRef: "account-1" }] as never);
    await complete();
    expect(revokeUnreferencedAccounts).toHaveBeenCalledWith(
      "gmail",
      ["account-1"],
      expect.anything(),
    );
    expect(jobs.enqueueIn).not.toHaveBeenCalled();
  });

  it("reports a superseded connection as revoked instead of failing", async () => {
    const { complete, connector, securityEvents } = pollFixture("revoked");

    await expect(complete()).resolves.toMatchObject({
      status: 200,
      body: { json: { id: "conn-1", status: "revoked" } },
    });
    expect(connector.connectionReady).not.toHaveBeenCalled();
    expect(securityEvents()).toEqual([]);
  });

  it("finishes removing a superseded remote after the poll that triggered it is aborted", async () => {
    const { complete, connector, row } = pollFixture("revoked");
    row.providerRef = "request-1";
    const poll = new AbortController();
    poll.abort();

    await expect(complete(row.id, poll.signal)).resolves.toMatchObject({
      body: { json: { status: "revoked" } },
    });
    expect(connector.revoke).toHaveBeenCalledWith(
      "request-1",
      expect.objectContaining({ signal: expect.objectContaining({ aborted: false }) }),
    );
  });

  it("records one credential event per connection, not per poll", async () => {
    const { complete, securityEvents, analytics, row } = pollFixture("pending");

    for (let poll = 0; poll < 3; poll += 1) {
      await expect(complete()).resolves.toMatchObject({
        status: 200,
        body: { json: { status: "connected" } },
      });
    }
    expect(securityEvents()).toHaveLength(1);
    expect(securityEvents()[0]).toMatchObject({
      "security.event.type": "credential.created",
      "security.event.metadata": {
        procedure: "connections.complete",
        kind: "connection",
        connectionId: "conn-1",
      },
    });
    expect(analytics.capture.mock.calls).toEqual([
      ["user-1", { name: "tool_connected", app: "gmail" }, { id: "conn-1", at: row.createdAt }],
    ]);
  });

  it("updates the chat card the connection started from once, on the poll that connects it", async () => {
    const origin = { botId: "bot-1", threadId: "thread-1", messageId: "message-1" };
    const { complete } = pollFixture("pending", { attempt: "attempt-1", origin });

    for (let poll = 0; poll < 3; poll += 1) {
      await expect(complete()).resolves.toMatchObject({ body: { json: { status: "connected" } } });
    }
    expect(markAppConnected).toHaveBeenCalledOnce();
    expect(markAppConnected).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ userId: "user-1" }),
      "bot-1",
      "gmail",
      "composio",
      "thread-1",
      "message-1",
      true,
    );
  });

  it("connects the row even when its card cannot be updated", async () => {
    const { complete } = pollFixture("pending", {
      origin: { botId: "bot-1", threadId: "thread-1" },
    });
    markAppConnected.mockRejectedValueOnce(new Error("thread gone"));

    await expect(complete()).resolves.toMatchObject({ body: { json: { status: "connected" } } });
  });

  it("records the credential and updates the card once when the catalog finds the app connected", async () => {
    const createdAt = new Date("2026-08-26T00:00:00.000Z");
    const row = {
      id: "conn-1",
      provider: "gmail",
      displayName: "Gmail",
      status: "pending",
      createdAt,
      metadata: { attempt: "a", origin: { botId: "bot-1", threadId: "thread-1" } },
    };
    const connection = {
      findMany: vi.fn(async () => [{ ...row }]),
      updateMany: vi.fn(async ({ where }: { where: { id?: string; status: string } }) => {
        if (where.id !== row.id || row.status !== where.status) return { count: 0 };
        row.status = "connected";
        return { count: 1 };
      }),
    };
    const prisma = {
      connection,
      $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({ connection })),
    } as unknown as PrismaClient;
    const provider = {
      describe: () => ({ id: "composio" }),
      catalog: vi.fn(async () => [
        {
          connectorId: "composio",
          slug: "gmail",
          name: "Gmail",
          logo: null,
          connected: true,
          noAuth: false,
        },
      ]),
    };
    const analytics = { capture: vi.fn(), flush: vi.fn() };
    const client = createRouterClient(
      createRouter({
        prisma,
        analytics,
        connectors: { managed: () => provider },
        env: {
          defaultProvider: "fake",
          defaultModel: "fake-model",
          webOrigin: "http://127.0.0.1:5173",
          screenProxySecret: "fake-test-secret",
          sandboxProvider: "fake",
        },
      } as unknown as RouterDeps),
      {
        context: {
          actor: {
            spaceId: "workspace-1",
            userId: "user-1",
            email: "user@rakazo.test",
            isDeploymentOwner: true,
          },
        } as never,
      },
    );
    const sink = createTestSink();
    installLogger(createLogger({ service: "rakazo-api", sinks: [sink] }));

    await client.connections.catalog({ connectorId: "composio" });
    await client.connections.catalog({ connectorId: "composio" });

    const events = sink.events.filter((event) => event.message === "security.event");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      "security.event.type": "credential.created",
      "security.event.metadata": { procedure: "connections.catalog", connectionId: "conn-1" },
    });
    expect(analytics.capture.mock.calls).toEqual([
      ["user-1", { name: "tool_connected", app: "gmail" }, { id: "conn-1", at: createdAt }],
    ]);
    // The catalog connected it before any callback could, so it updates the card itself.
    expect(markAppConnected).toHaveBeenCalledOnce();
    expect(markAppConnected).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ userId: "user-1" }),
      "bot-1",
      "gmail",
      "composio",
      "thread-1",
      undefined,
      true,
    );
  });

  it("records nothing while the connection is still pending", async () => {
    const { complete, connector, securityEvents, analytics } = pollFixture("pending");
    connector.connectionReady.mockResolvedValue(false);

    await expect(complete()).resolves.toMatchObject({ body: { json: { status: "pending" } } });
    expect(securityEvents()).toEqual([]);
    expect(analytics.capture).not.toHaveBeenCalled();
  });
});
