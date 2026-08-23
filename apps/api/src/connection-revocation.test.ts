import { performance } from "node:perf_hooks";
import { GTASKS_SLACK_ROUTING, type GtasksSlackPort, syncGtasksSlackInbox } from "@rakazo/adapters";
import { describe, expect, it, vi } from "vitest";
import { revokeConnection } from "./connection-revocation.js";

const context = {
  operationId: "connections.revoke",
  traceId: "connections.revoke",
  workspaceId: "workspace-1",
  userId: "user-1",
  signal: new AbortController().signal,
};

type ConnectionRow = {
  id: string;
  workspaceId: string;
  userId: string;
  connectorId: string;
  provider: string;
  status: string;
};

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function createPrisma(
  rows: ConnectionRow[],
  options: {
    onExclusiveLock?: () => void | Promise<void>;
    findBot?: () => Promise<unknown>;
  } = {},
) {
  const connection = {
    updateMany: vi.fn(
      async ({
        where,
        data,
      }: {
        where: { userId?: string; connectorId?: string; provider?: string };
        data: { status: string };
      }) => {
        let count = 0;
        for (const row of rows) {
          if (where.userId !== undefined && row.userId !== where.userId) continue;
          if (where.connectorId !== undefined && row.connectorId !== where.connectorId) continue;
          if (where.provider !== undefined && row.provider !== where.provider) continue;
          row.status = data.status;
          count += 1;
        }
        return { count };
      },
    ),
  };
  const transactionClient = {
    connection,
    integrationMirror: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    $queryRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const query = strings.join("?");
      if (query.includes("set_config('lock_timeout'")) return [];
      if (query.includes("pg_advisory_xact_lock(hashtextextended")) {
        await options.onExclusiveLock?.();
        return [];
      }
      if (query.includes("pg_advisory_xact_lock_shared")) return [];
      if (query.includes('FROM "member"')) return [{ id: "member-1" }];
      if (
        query.includes('SELECT "id", "connectorId", "provider"') &&
        query.includes('WHERE "id"')
      ) {
        const [id, workspaceId, userId] = values;
        return rows
          .filter(
            (row) => row.id === id && row.workspaceId === workspaceId && row.userId === userId,
          )
          .map(({ id: rowId, connectorId, provider }) => ({ id: rowId, connectorId, provider }));
      }
      if (query.includes('SELECT "id"') && query.includes('WHERE "userId"')) {
        const [userId, connectorId, provider] = values;
        return rows
          .filter(
            (row) =>
              row.userId === userId && row.connectorId === connectorId && row.provider === provider,
          )
          .map(({ id }) => ({ id }));
      }
      if (query.includes('SELECT "provider"') && query.includes('FROM "connections"')) {
        const [workspaceId, userId, connectorId, googleTasks, slack] = values;
        return rows
          .filter(
            (row) =>
              row.workspaceId === workspaceId &&
              row.userId === userId &&
              row.connectorId === connectorId &&
              row.status === "connected" &&
              (row.provider === googleTasks || row.provider === slack),
          )
          .map(({ provider }) => ({ provider }));
      }
      return [];
    }),
  };
  let transactionTail = Promise.resolve();
  return {
    rows,
    connection,
    $transaction: vi.fn(async (callback: (tx: typeof transactionClient) => Promise<unknown>) => {
      const previous = transactionTail;
      let release = () => {};
      transactionTail = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        return await callback(transactionClient);
      } finally {
        release();
      }
    }),
    bot: {
      findFirst: vi.fn(options.findBot ?? (async () => null)),
    },
  };
}

function connectedRows(): ConnectionRow[] {
  return [
    {
      id: "connection-1",
      workspaceId: context.workspaceId,
      userId: context.userId,
      connectorId: GTASKS_SLACK_ROUTING.connectorId,
      provider: GTASKS_SLACK_ROUTING.composioProviders.googleTasks,
      status: "connected",
    },
  ];
}

describe("connection revocation", () => {
  it("revokes the provider before committing local authorization", async () => {
    const rows = connectedRows();
    const prisma = createPrisma(rows);
    const revoke = vi.fn(async () => {
      expect(rows[0]?.status).toBe("connected");
    });

    await revokeConnection(
      { prisma: prisma as never, connectors: connectorRegistry(revoke) as never },
      "connection-1",
      context,
    );

    expect(rows[0]?.status).toBe("revoked");
    expect(revoke).toHaveBeenCalledOnce();
    expect(prisma.connection.updateMany).toHaveBeenCalledWith({
      where: {
        userId: context.userId,
        connectorId: GTASKS_SLACK_ROUTING.connectorId,
        provider: GTASKS_SLACK_ROUTING.composioProviders.googleTasks,
      },
      data: { status: "revoked" },
    });
  });

  it("keeps local authorization retryable when provider revocation fails", async () => {
    const rows = connectedRows();
    const prisma = createPrisma(rows);

    await expect(
      revokeConnection(
        {
          prisma: prisma as never,
          connectors: connectorRegistry(
            vi.fn(async () => Promise.reject(new Error("offline"))),
          ) as never,
        },
        "connection-1",
        context,
      ),
    ).rejects.toThrow("offline");
    expect(rows[0]?.status).toBe("connected");
    expect(prisma.connection.updateMany).not.toHaveBeenCalled();
  });

  it("waits for an active mirror connection lease", async () => {
    const mirrorReleased = deferred();
    const lockRequest = deferred();
    const revoke = vi.fn(async () => {});
    const prisma = createPrisma(connectedRows(), {
      async onExclusiveLock() {
        lockRequest.resolve();
        await mirrorReleased.promise;
      },
    });

    const revocation = revokeConnection(
      { prisma: prisma as never, connectors: connectorRegistry(revoke) as never },
      "connection-1",
      context,
    );
    await lockRequest.promise;

    expect(revoke).not.toHaveBeenCalled();
    expect(prisma.connection.updateMany).not.toHaveBeenCalled();

    mirrorReleased.resolve();
    await revocation;

    expect(revoke).toHaveBeenCalledOnce();
    expect(prisma.connection.updateMany).toHaveBeenCalledOnce();
  });

  it("does not start provider revocation after lock wait exhausts its deadline", async () => {
    let now = 1_000;
    const nowSpy = vi.spyOn(performance, "now").mockImplementation(() => now);
    try {
      const revoke = vi.fn(async () => {});
      const prisma = createPrisma(connectedRows(), {
        onExclusiveLock() {
          now += 66_000;
        },
      });

      await expect(
        revokeConnection(
          { prisma: prisma as never, connectors: connectorRegistry(revoke) as never },
          "connection-1",
          context,
        ),
      ).rejects.toThrow("deadline exhausted");
      expect(revoke).not.toHaveBeenCalled();
      expect(prisma.connection.updateMany).not.toHaveBeenCalled();
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("prevents cached delivery after revocation in another workspace", async () => {
    const googleTasks = GTASKS_SLACK_ROUTING.composioProviders.googleTasks;
    const slack = GTASKS_SLACK_ROUTING.composioProviders.slack;
    const workspaceB = "workspace-2";
    const rows: ConnectionRow[] = [
      ...connectedRows(),
      {
        id: "slack-1",
        workspaceId: context.workspaceId,
        userId: context.userId,
        connectorId: GTASKS_SLACK_ROUTING.connectorId,
        provider: slack,
        status: "connected",
      },
      {
        id: "google-2",
        workspaceId: workspaceB,
        userId: context.userId,
        connectorId: GTASKS_SLACK_ROUTING.connectorId,
        provider: googleTasks,
        status: "connected",
      },
      {
        id: "slack-2",
        workspaceId: workspaceB,
        userId: context.userId,
        connectorId: GTASKS_SLACK_ROUTING.connectorId,
        provider: slack,
        status: "connected",
      },
    ];
    const reachedDelivery = deferred();
    const releaseDelivery = deferred();
    const prisma = createPrisma(rows, {
      async findBot() {
        reachedDelivery.resolve();
        await releaseDelivery.promise;
        return null;
      },
    });
    const posts: string[] = [];
    const port: GtasksSlackPort = {
      listInboxTasks: vi.fn(async () => [
        {
          id: "task-cached",
          title: "Cached task",
          updated: "2026-08-18T10:00:00Z",
        },
      ]),
      postSlackMessage: vi.fn(async (_ctx, text) => {
        posts.push(text);
        return { messageTs: "ts-1" };
      }),
      updateSlackMessage: vi.fn(),
    };
    const composio = {
      connectionReady: vi.fn(async () => true),
      revoke: vi.fn(async () => {}),
    };

    const sync = syncGtasksSlackInbox(
      { prisma: prisma as never, composio: composio as never, port },
      { workspaceId: workspaceB, userId: context.userId },
    );
    await reachedDelivery.promise;

    await revokeConnection(
      { prisma: prisma as never, connectors: connectorRegistry(composio.revoke) as never },
      "connection-1",
      context,
    );
    releaseDelivery.resolve();
    const result = await sync;

    expect(result).toEqual({ status: "skipped", reason: "connector_unavailable" });
    expect(posts).toHaveLength(0);
    expect(rows.find((row) => row.id === "google-2")?.status).toBe("revoked");
    expect(rows.find((row) => row.id === "slack-2")?.status).toBe("connected");
  });
});

function connectorRegistry(revoke: (provider: string, context: unknown) => Promise<void>) {
  return { managed: vi.fn(() => ({ revoke })) };
}
