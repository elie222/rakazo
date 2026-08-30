import { RPCHandler } from "@orpc/server/fetch";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { createRouter, type RouterDeps } from "./router.js";

const identity = {
  id: "pi-1",
  phoneE164: "+15551111111",
  userId: "user-1",
  workspaceId: "ws-1",
  botId: "bot-1",
  outboundSinceInbound: 0,
};

function phoneDeps(
  overrides: {
    enabled?: boolean;
    identity?: unknown;
    membership?: Record<string, unknown> | null;
    memberships?: Array<Record<string, unknown>>;
    connection?: Record<string, unknown> | null;
    connections?: Array<Record<string, unknown>>;
  } = {},
) {
  const resolvedIdentity = overrides.identity === undefined ? identity : overrides.identity;
  const membership =
    overrides.membership === undefined
      ? {
          id: "pm-1",
          channelId: "ch-1",
          phoneE164: "+15551111111",
          identityId: "pi-1",
          status: "invited",
          channel: { id: "ch-1", name: "Family", members: [{ id: "pm-1" }, { id: "pm-2" }] },
        }
      : overrides.membership;
  const connection =
    overrides.connection === undefined
      ? {
          id: "ac-1",
          requesterBotId: "bot-9",
          targetBotId: "bot-1",
          status: "pending",
        }
      : overrides.connection;
  const membershipState = membership ? { ...membership } : null;
  const connectionState = connection ? { ...connection } : null;
  const prisma = {
    phoneIdentity: {
      findFirst: vi.fn(async () => resolvedIdentity),
      findUnique: vi.fn(async ({ where }: { where: { botId?: string } }) =>
        where.botId === "bot-9"
          ? { id: "pi-9", phoneE164: "+15559999999", userId: "user-9", botId: "bot-9" }
          : resolvedIdentity,
      ),
    },
    phoneChannelMember: {
      findMany: vi.fn(async () => overrides.memberships ?? (membership ? [membership] : [])),
      findFirst: vi.fn(async () => membership),
      update: vi.fn(async ({ data }: { data: unknown }) => ({
        ...membership,
        ...(data as object),
        channel: membership?.channel ?? { id: "ch-1", name: "Family", members: [] },
      })),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id?: string; status?: string };
          data: Record<string, unknown>;
        }) => {
          if (!membershipState) return { count: 0 };
          if (where.id && membershipState.id !== where.id) return { count: 0 };
          if (where.status && membershipState.status !== where.status) return { count: 0 };
          Object.assign(membershipState, data);
          return { count: 1 };
        },
      ),
      findUniqueOrThrow: vi.fn(async () => membershipState),
    },
    agentConnection: {
      findMany: vi.fn(async () => overrides.connections ?? (connection ? [connection] : [])),
      findFirst: vi.fn(
        async ({
          where,
        }: {
          where?: {
            id?: string;
            targetBotId?: string;
            status?: string;
            OR?: Array<Record<string, string>>;
          };
        }) => {
          if (!connection) return null;
          if (where?.id && connection.id !== where.id) return null;
          if (where?.targetBotId && connection.targetBotId !== where.targetBotId) return null;
          if (where?.status && connection.status !== where.status) return null;
          if (where?.OR) {
            const involved = where.OR.some(
              (cond) =>
                connection.requesterBotId === cond.requesterBotId ||
                connection.targetBotId === cond.targetBotId,
            );
            if (!involved) return null;
          }
          return connection;
        },
      ),
      update: vi.fn(async ({ data }: { data: unknown }) => ({
        ...connection,
        ...(data as object),
      })),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id?: string; status?: string };
          data: Record<string, unknown>;
        }) => {
          if (!connectionState) return { count: 0 };
          if (where.id && connectionState.id !== where.id) return { count: 0 };
          if (where.status && connectionState.status !== where.status) return { count: 0 };
          Object.assign(connectionState, data);
          return { count: 1 };
        },
      ),
      findUniqueOrThrow: vi.fn(async () => connectionState),
    },
    bot: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => ({
        id: where.id,
        name: where.id === "bot-9" ? "Helper" : "Assistant",
      })),
    },
    user: {
      findUnique: vi.fn(async () => ({ id: "user-9", name: "Bob Owner" })),
    },
  } as unknown as PrismaClient;
  const outboundRows: Array<Record<string, unknown>> = [];
  const phoneOutbound = {
    createMany: vi.fn(async ({ data }: { data: Array<Record<string, unknown>> }) => {
      let count = 0;
      for (const item of data) {
        // Honors skipDuplicates against the idempotencyKey unique key.
        if (outboundRows.some((row) => row.idempotencyKey === item.idempotencyKey)) continue;
        outboundRows.push(item);
        count += 1;
      }
      return { count };
    }),
    deleteMany: vi.fn(
      async ({
        where,
      }: {
        where: {
          idempotencyKey?: string;
          status?: string;
          OR?: Array<{ status?: string; providerHandle?: null }>;
        };
      }) => {
        let count = 0;
        for (let i = outboundRows.length - 1; i >= 0; i -= 1) {
          const row = outboundRows[i]!;
          if (where.idempotencyKey && row.idempotencyKey !== where.idempotencyKey) continue;
          if (where.status && row.status !== where.status) continue;
          if (where.OR) {
            const matches = where.OR.some((clause) => {
              if (clause.status && row.status !== clause.status) return false;
              if ("providerHandle" in clause && clause.providerHandle === null) {
                return row.providerHandle == null;
              }
              return true;
            });
            if (!matches) continue;
          }
          outboundRows.splice(i, 1);
          count += 1;
        }
        return { count };
      },
    ),
  };
  (prisma as { phoneOutbound?: unknown }).phoneOutbound = phoneOutbound;
  // The claim-and-confirm handlers run inside one interactive transaction;
  // the mock passes the same stateful models as the tx delegate.
  (prisma as { $transaction?: unknown }).$transaction = vi.fn(
    async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma),
  );
  const enqueue = vi.fn(async () => undefined);
  const deps = {
    prisma,
    jobs: { enqueue },
    env: {
      defaultProvider: "fake",
      defaultModel: "fake-model",
      webOrigin: "http://127.0.0.1:5173",
      screenProxySecret: "fake-test-secret",
      sandboxProvider: "fake",
    },
    phone: { enabled: overrides.enabled ?? true },
    dataDir: "/tmp/rakazo-router-test",
  } as unknown as RouterDeps;
  const actor = {
    workspaceId: "ws-1",
    userId: "user-1",
    email: "user@rakazo.test",
    isDeploymentOwner: false,
  } satisfies Actor;
  return {
    prisma,
    deps,
    actor,
    outboundRows,
    enqueue,
    handler: new RPCHandler(createRouter(deps)),
  };
}

async function call(handler: RPCHandler<never>, actor: Actor, path: string, body: unknown = {}) {
  const { response } = await handler.handle(
    new Request(`http://127.0.0.1/rpc/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ json: body }),
    }),
    { prefix: "/rpc", context: { actor } },
  );
  return response;
}

describe("phone.status", () => {
  it("reports enablement and the caller's link state", async () => {
    const { handler, actor } = phoneDeps({ enabled: true });
    const response = await call(handler, actor, "phone/status");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      json: {
        enabled: true,
        linked: true,
        phoneE164: "+15551111111",
        botId: "bot-1",
      },
    });
  });

  it("reports unlinked when the caller has no phone identity", async () => {
    const { handler, actor } = phoneDeps({ identity: null });
    const response = await call(handler, actor, "phone/status");
    await expect(response.json()).resolves.toEqual({
      json: { enabled: true, linked: false, phoneE164: null, botId: null },
    });
  });
});

describe("phone.channels", () => {
  it("lists the caller's memberships with channel names, counting only active members", async () => {
    const { handler, actor, prisma } = phoneDeps();
    const response = await call(handler, actor, "phone/channels/list");
    expect(prisma.phoneChannelMember.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        include: expect.objectContaining({
          channel: expect.objectContaining({
            include: expect.objectContaining({
              members: expect.objectContaining({
                where: { status: { in: ["invited", "approved"] } },
              }),
            }),
          }),
        }),
      }),
    );
    await expect(response.json()).resolves.toEqual({
      json: [{ channelId: "ch-1", name: "Family", status: "invited", memberCount: 2 }],
    });
  });

  it("approves an invited membership", async () => {
    const { handler, actor, prisma } = phoneDeps();
    const approved = await call(handler, actor, "phone/channels/respond", {
      channelId: "ch-1",
      accept: true,
    });
    expect(prisma.phoneChannelMember.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "pm-1", status: "invited" },
        data: { status: "approved" },
      }),
    );
    await expect(approved.json()).resolves.toEqual({
      json: expect.objectContaining({ status: "approved" }),
    });
  });

  it("declines an invited membership on accept=false", async () => {
    const { handler, actor, prisma } = phoneDeps();
    const declined = await call(handler, actor, "phone/channels/respond", {
      channelId: "ch-1",
      accept: false,
    });
    expect(prisma.phoneChannelMember.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "pm-1", status: "invited" },
        data: { status: "declined" },
      }),
    );
    await expect(declined.json()).resolves.toEqual({
      json: expect.objectContaining({ status: "declined" }),
    });
  });

  it("rejects respond on another user's membership or a non-invited one", async () => {
    const foreign = phoneDeps({ membership: null });
    const response = await call(foreign.handler, foreign.actor, "phone/channels/respond", {
      channelId: "ch-1",
      accept: true,
    });
    expect(response.status).toBeGreaterThanOrEqual(400);

    const already = phoneDeps({
      membership: {
        id: "pm-1",
        channelId: "ch-1",
        identityId: "pi-1",
        status: "approved",
        channel: { id: "ch-1", name: "Family", members: [] },
      },
    });
    const second = await call(already.handler, already.actor, "phone/channels/respond", {
      channelId: "ch-1",
      accept: true,
    });
    expect(second.status).toBeGreaterThanOrEqual(400);
  });

  it("leaves an approved channel", async () => {
    const { handler, actor, prisma } = phoneDeps({
      membership: {
        id: "pm-1",
        channelId: "ch-1",
        identityId: "pi-1",
        status: "approved",
        channel: { id: "ch-1", name: "Family", members: [] },
      },
    });
    const response = await call(handler, actor, "phone/channels/leave", { channelId: "ch-1" });
    expect(prisma.phoneChannelMember.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: "left" } }),
    );
    await expect(response.json()).resolves.toEqual({ json: { ok: true } });
  });
});

describe("phone.connections", () => {
  it("lists connections with the peer label and direction", async () => {
    const { handler, actor } = phoneDeps();
    const response = await call(handler, actor, "phone/connections/list");
    await expect(response.json()).resolves.toEqual({
      json: [
        {
          id: "ac-1",
          peerBotName: "Helper",
          peerOwnerLabel: "Bob",
          status: "pending",
          incoming: true,
        },
      ],
    });
  });

  it("hides peer identity for outgoing connections that are not approved", async () => {
    const { handler, actor } = phoneDeps({
      connection: { id: "ac-4", requesterBotId: "bot-1", targetBotId: "bot-9", status: "pending" },
    });
    const response = await call(handler, actor, "phone/connections/list");
    await expect(response.json()).resolves.toEqual({
      json: [
        expect.objectContaining({ peerBotName: "agent", peerOwnerLabel: "owner", incoming: false }),
      ],
    });
  });

  it("approves a pending incoming connection and texts the requester", async () => {
    const { handler, actor, prisma, outboundRows, enqueue } = phoneDeps();
    const response = await call(handler, actor, "phone/connections/respond", {
      connectionId: "ac-1",
      accept: true,
    });
    expect(prisma.agentConnection.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "ac-1", status: "pending" },
        data: { status: "approved" },
      }),
    );
    await expect(response.json()).resolves.toEqual({
      json: expect.objectContaining({ status: "approved" }),
    });
    expect(outboundRows).toEqual([
      expect.objectContaining({
        idempotencyKey: "command:connected:ac-1",
        kind: "dm",
        toNumber: "+15559999999",
      }),
    ]);
    expect(enqueue).toHaveBeenCalled();
  });

  it("rejects respond from the requester side", async () => {
    const outgoing = phoneDeps({
      connection: { id: "ac-2", requesterBotId: "bot-1", targetBotId: "bot-9", status: "pending" },
    });
    const response = await call(outgoing.handler, outgoing.actor, "phone/connections/respond", {
      connectionId: "ac-2",
      accept: true,
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
  });

  it("revokes an approved connection from either side", async () => {
    const { handler, actor, prisma } = phoneDeps({
      connection: { id: "ac-3", requesterBotId: "bot-1", targetBotId: "bot-9", status: "approved" },
    });
    const response = await call(handler, actor, "phone/connections/revoke", {
      connectionId: "ac-3",
    });
    expect(prisma.agentConnection.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "ac-3", status: "approved" },
        data: { status: "revoked" },
      }),
    );
    await expect(response.json()).resolves.toEqual({ json: { ok: true } });
  });

  it("cancels a pending connect invite when revoking a re-requested connection", async () => {
    const { handler, actor, prisma, outboundRows } = phoneDeps({
      connection: { id: "ac-4", requesterBotId: "bot-1", targetBotId: "bot-9", status: "pending" },
    });
    outboundRows.push({
      idempotencyKey: "connect:bot-1:bot-9",
      kind: "dm",
      toNumber: "+15559999999",
      body: "wants to connect",
      status: "pending",
    });
    outboundRows.push({
      idempotencyKey: "connect:bot-1:bot-9-already-sent",
      kind: "dm",
      status: "sent",
    });

    const response = await call(handler, actor, "phone/connections/revoke", {
      connectionId: "ac-4",
    });

    expect(prisma.phoneOutbound.deleteMany).toHaveBeenCalledWith({
      where: {
        idempotencyKey: "connect:bot-1:bot-9",
        OR: [{ status: "pending" }, { status: "sent", providerHandle: null }],
      },
    });
    expect(outboundRows).toEqual([
      expect.objectContaining({
        idempotencyKey: "connect:bot-1:bot-9-already-sent",
        status: "sent",
      }),
    ]);
    await expect(response.json()).resolves.toEqual({ json: { ok: true } });
  });

  it("cancels a claimed-but-undelivered connect invite on revoke", async () => {
    const { handler, actor, outboundRows } = phoneDeps({
      connection: {
        id: "ac-claimed",
        requesterBotId: "bot-1",
        targetBotId: "bot-9",
        status: "pending",
      },
    });
    outboundRows.push({
      idempotencyKey: "connect:bot-1:bot-9",
      kind: "dm",
      status: "sent",
      providerHandle: null,
      body: "claimed by drain",
    });
    outboundRows.push({
      idempotencyKey: "connect:bot-1:bot-9-delivered",
      kind: "dm",
      status: "sent",
      providerHandle: "h-delivered",
    });

    const response = await call(handler, actor, "phone/connections/revoke", {
      connectionId: "ac-claimed",
    });

    expect(outboundRows).toEqual([
      expect.objectContaining({
        idempotencyKey: "connect:bot-1:bot-9-delivered",
        providerHandle: "h-delivered",
      }),
    ]);
    await expect(response.json()).resolves.toEqual({ json: { ok: true } });
  });

  it("revokes status and cancels invites in one transaction", async () => {
    const { handler, actor, prisma, outboundRows } = phoneDeps({
      connection: { id: "ac-5", requesterBotId: "bot-1", targetBotId: "bot-9", status: "pending" },
    });
    outboundRows.push({
      idempotencyKey: "connect:bot-1:bot-9",
      kind: "dm",
      status: "pending",
    });
    const order: string[] = [];
    const connectionModel = prisma.agentConnection as unknown as {
      updateMany: (args: unknown) => Promise<{ count: number }>;
    };
    const baseUpdateMany = connectionModel.updateMany.bind(connectionModel);
    const baseDeleteMany = prisma.phoneOutbound.deleteMany;
    (prisma as unknown as Record<string, unknown>).$transaction = vi.fn(
      async (fn: (tx: unknown) => Promise<unknown>) => {
        order.push("tx-start");
        const result = await fn({
          agentConnection: {
            updateMany: async (args: unknown) => {
              order.push("update");
              return baseUpdateMany(args);
            },
          },
          phoneOutbound: {
            deleteMany: async (args: unknown) => {
              order.push("delete");
              return baseDeleteMany(args as never);
            },
          },
        });
        order.push("tx-end");
        return result;
      },
    );

    const response = await call(handler, actor, "phone/connections/revoke", {
      connectionId: "ac-5",
    });

    expect(order).toEqual(["tx-start", "update", "delete", "tx-end"]);
    expect(outboundRows).toEqual([]);
    await expect(response.json()).resolves.toEqual({ json: { ok: true } });
  });

  it("does not delete a reconnect invite created after revoke commits", async () => {
    const { handler, actor, prisma, outboundRows } = phoneDeps({
      connection: { id: "ac-6", requesterBotId: "bot-1", targetBotId: "bot-9", status: "pending" },
    });
    outboundRows.push({
      idempotencyKey: "connect:bot-1:bot-9",
      kind: "dm",
      status: "pending",
      body: "old invite",
    });
    const connectionModel = prisma.agentConnection as unknown as {
      updateMany: (args: unknown) => Promise<{ count: number }>;
    };
    const baseUpdateMany = connectionModel.updateMany.bind(connectionModel);
    const baseDeleteMany = prisma.phoneOutbound.deleteMany;
    (prisma as unknown as Record<string, unknown>).$transaction = vi.fn(
      async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          agentConnection: {
            updateMany: async (args: unknown) => baseUpdateMany(args),
          },
          phoneOutbound: {
            deleteMany: async (args: unknown) => baseDeleteMany(args as never),
          },
        }),
    );

    await call(handler, actor, "phone/connections/revoke", { connectionId: "ac-6" });
    expect(outboundRows).toEqual([]);

    // Reconnect after revoke has committed: its fresh invite must survive.
    outboundRows.push({
      idempotencyKey: "connect:bot-1:bot-9",
      kind: "dm",
      status: "pending",
      body: "fresh reconnect invite",
    });
    expect(prisma.phoneOutbound.deleteMany).toHaveBeenCalledTimes(1);
    expect(outboundRows).toEqual([
      expect.objectContaining({
        idempotencyKey: "connect:bot-1:bot-9",
        body: "fresh reconnect invite",
      }),
    ]);
  });

  it("does not let a stale revoke overwrite a newer pending re-request", async () => {
    const { handler, actor, prisma } = phoneDeps({
      connection: {
        id: "ac-stale",
        requesterBotId: "bot-1",
        targetBotId: "bot-9",
        status: "approved",
      },
    });
    const state = { status: "approved" };
    const connectionModel = prisma.agentConnection as unknown as Record<string, unknown>;
    connectionModel.findFirst = vi.fn(async () => {
      const snapshot = {
        id: "ac-stale",
        requesterBotId: "bot-1",
        targetBotId: "bot-9",
        status: state.status,
      };
      // Interleaved: a new request flips the row back to pending after the read.
      state.status = "pending";
      return snapshot;
    });
    connectionModel.updateMany = vi.fn(
      async ({ where, data }: { where: { status?: string }; data: Record<string, unknown> }) => {
        if (where.status && state.status !== where.status) return { count: 0 };
        Object.assign(state, data);
        return { count: 1 };
      },
    );
    const response = await call(handler, actor, "phone/connections/revoke", {
      connectionId: "ac-stale",
    });

    expect(state.status).toBe("pending");
    expect(response.status).toBeGreaterThanOrEqual(400);
  });
});

describe("phone status-write races", () => {
  it("does not overwrite a concurrent revoke when responding to a connection", async () => {
    const { handler, actor, prisma, outboundRows } = phoneDeps();
    const state = { status: "pending" };
    const connectionModel = prisma.agentConnection as unknown as Record<string, unknown>;
    connectionModel.findFirst = vi.fn(async () => {
      const snapshot = {
        id: "ac-1",
        requesterBotId: "bot-9",
        targetBotId: "bot-1",
        status: state.status,
      };
      // Interleaved: the requester revokes between the read and the write.
      state.status = "revoked";
      return snapshot;
    });
    connectionModel.update = vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      Object.assign(state, data);
      return state;
    });
    connectionModel.updateMany = vi.fn(
      async ({ where, data }: { where: { status?: string }; data: Record<string, unknown> }) => {
        if (where.status && state.status !== where.status) return { count: 0 };
        Object.assign(state, data);
        return { count: 1 };
      },
    );
    const response = await call(handler, actor, "phone/connections/respond", {
      connectionId: "ac-1",
      accept: true,
    });

    expect(state.status).toBe("revoked");
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(outboundRows).toHaveLength(0);
  });

  it("does not overwrite a concurrent leave when responding to a channel invite", async () => {
    const { handler, actor, prisma } = phoneDeps();
    const state = { status: "invited" };
    const memberModel = prisma.phoneChannelMember as unknown as Record<string, unknown>;
    memberModel.findFirst = vi.fn(async () => {
      const snapshot = {
        id: "pm-1",
        channelId: "ch-1",
        phoneE164: "+15551111111",
        identityId: "pi-1",
        status: state.status,
        channel: { id: "ch-1", name: "Family", members: [{ id: "pm-1" }] },
      };
      // Interleaved: the owner left (or was swept out) after the read.
      state.status = "left";
      return snapshot;
    });
    memberModel.update = vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      Object.assign(state, data);
      return state;
    });
    memberModel.updateMany = vi.fn(
      async ({ where, data }: { where: { status?: string }; data: Record<string, unknown> }) => {
        if (where.status && state.status !== where.status) return { count: 0 };
        Object.assign(state, data);
        return { count: 1 };
      },
    );
    const response = await call(handler, actor, "phone/channels/respond", {
      channelId: "ch-1",
      accept: true,
    });

    expect(state.status).toBe("left");
    expect(response.status).toBeGreaterThanOrEqual(400);
  });
});

describe("phone.connections.respond confirmation atomicity", () => {
  it("writes the requester confirmation under the claim's transaction", async () => {
    const { handler, actor, prisma, outboundRows } = phoneDeps();
    // Track the transaction-scoped outbox delegate separately: a revoke can
    // only be excluded from the confirmation window if the claim's row lock
    // is still held when the confirmation row is written.
    const txCreateMany = vi.fn(async ({ data }: { data: Array<Record<string, unknown>> }) => {
      outboundRows.push(...data);
      return { count: data.length };
    });
    (prisma as unknown as Record<string, unknown>).$transaction = vi.fn(
      async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          agentConnection: prisma.agentConnection,
          phoneIdentity: prisma.phoneIdentity,
          phoneOutbound: {
            createMany: txCreateMany,
            deleteMany: vi.fn(async () => ({ count: 0 })),
          },
        }),
    );
    const response = await call(handler, actor, "phone/connections/respond", {
      connectionId: "ac-1",
      accept: true,
    });

    expect(response.status).toBe(200);
    expect(txCreateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [expect.objectContaining({ idempotencyKey: "command:connected:ac-1" })],
      }),
    );
  });
});
