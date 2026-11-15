import type { ManagedConnectorProvider } from "@rakazo/adapter-kit";
import { currentDbContext } from "@rakazo/db";
import { createLogger, createTestSink, installLogger } from "@rakazo/logging";
import { describe, expect, it, vi } from "vitest";
import { createBackgroundJobHandlers } from "./background-job-handlers.js";
import { leftoverAuthorization } from "./connection-cleanup.js";

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
  const tx = { connection, $executeRaw: vi.fn(async () => undefined) };
  const prisma = { $transaction: vi.fn(async (fn: (client: typeof tx) => unknown) => fn(tx)) };
  const handlers = createBackgroundJobHandlers({
    prisma,
    connectors: { managed: () => connector },
  } as unknown as Parameters<typeof createBackgroundJobHandlers>[0]);
  const sink = createTestSink();
  installLogger(createLogger({ service: "rakazo-worker", sinks: [sink] }));
  return { run: handlers["connection.cleanup"], connection, sink };
}

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

    // A row without a concrete account id may own any remote account, so nothing is deleted.
    revokeUnreferencedAccounts.mockClear();
    connection.findMany.mockResolvedValue([{ providerRef: "account-1" }, { providerRef: "mail" }]);
    await run(scope);
    expect(revokeUnreferencedAccounts).not.toHaveBeenCalled();
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

  it("reports a cleanup whose connector is gone instead of retrying it forever", async () => {
    const { run, sink } = cleanupJob(undefined);

    await expect(run(request)).resolves.toBeUndefined();
    expect(sink.events.filter((event) => event.level === "error")).toEqual([
      expect.objectContaining({
        connectorId: "connector-1",
        provider: "mail",
        providerRef: "request-1",
      }),
    ]);
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
