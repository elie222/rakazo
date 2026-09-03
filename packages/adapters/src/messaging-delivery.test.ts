import type { AdapterContext, MessagingSurface } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import {
  applyMessagingOutboundStatus,
  deliverMessagingOutbound,
  MESSAGING_DM_OUTBOUND_CAP,
  MESSAGING_OUTBOUND_MAX_ATTEMPTS,
  type MessagingDeliveryDeps,
} from "./messaging-delivery.js";

const context: AdapterContext = {
  operationId: "op-1",
  traceId: "trace-1",
  spaceId: "ws-1",
  userId: "user-1",
  signal: new AbortController().signal,
};

const identity = {
  id: "mi-1",
  provider: "sendblue",
  address: "+15551234567",
  dmThreadId: "sendblue:dm-1",
  userId: "user-1",
  spaceId: "ws-1",
  botId: "bot-1",
  outboundSinceInbound: 0,
};

const messagingRun = {
  id: "run-1",
  botId: "bot-1",
  trigger: "messaging",
  sourceMessage: { blocks: [{ kind: "text", text: "hi" }] },
};

function createFakeSurface(sendError?: Error) {
  const sendToThread = vi.fn(async () => ({ handle: "handle-out-1" }));
  if (sendError) sendToThread.mockRejectedValue(sendError);
  const openDirectThread = vi.fn(
    async (_provider: string, address: string) => `sendblue:opened:${address}`,
  );
  const messaging: MessagingSurface = {
    describe: () => ({
      id: "chat-sdk",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { providers: ["sendblue"] },
    }),
    platforms: () => [
      { provider: "sendblue", capabilities: { direct: true, groups: true, typing: true } },
    ],
    handleWebhook: () => null,
    onInbound: () => undefined,
    sendToThread,
    openDirectThread,
    sendTyping: vi.fn(async () => undefined),
  };
  return { messaging, sendToThread, openDirectThread };
}

function createDeps(overrides: {
  run?: unknown;
  identity?: Record<string, unknown> | null;
  messages?: unknown[];
  outboundRows?: unknown[];
  existingOutbox?: unknown;
  sendError?: Error;
  connectionStatus?: string | null;
}) {
  const rows = [...(overrides.outboundRows ?? [])] as Array<Record<string, unknown>>;
  const { messaging, sendToThread, openDirectThread } = createFakeSurface(overrides.sendError);
  // Stateful identity row so a cached dmThreadId is visible to later reads.
  const identityRow =
    overrides.identity === null ? null : { ...identity, ...(overrides.identity ?? {}) };
  const prisma = {
    run: {
      findUnique: vi.fn(async () => overrides.run ?? messagingRun),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    message: {
      findMany: vi.fn(
        async () =>
          overrides.messages ?? [
            { id: "m-1", blocks: [{ kind: "text", text: "Hello from your bot" }] },
          ],
      ),
    },
    messagingIdentity: {
      findUnique: vi.fn(async () => identityRow),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        if (identityRow && typeof data.dmThreadId === "string") {
          identityRow.dmThreadId = data.dmThreadId;
        }
        return identityRow;
      }),
    },
    agentConnection: {
      findUnique: vi.fn(async () =>
        overrides.connectionStatus === null
          ? null
          : overrides.connectionStatus
            ? { status: overrides.connectionStatus }
            : { status: "pending" },
      ),
    },
    $queryRaw: vi.fn(async () =>
      overrides.connectionStatus === null
        ? []
        : [{ status: overrides.connectionStatus ?? "pending" }],
    ),
    messagingOutbound: {
      findUnique: vi.fn(async ({ where }: { where?: { id?: string } } = {}) => {
        if (overrides.existingOutbox) return overrides.existingOutbox;
        if (where?.id) return rows.find((row) => row.id === where.id) ?? null;
        return null;
      }),
      findMany: vi.fn(async ({ where }: { where?: { status?: string; OR?: unknown[] } } = {}) => {
        const now = Date.now();
        return rows.filter((row) => {
          if (where?.status && row.status !== where.status) return false;
          if (!where?.OR) return row.status === "pending";
          const next = row.nextAttemptAt;
          if (next == null) return true;
          const nextMs = next instanceof Date ? next.getTime() : new Date(String(next)).getTime();
          return nextMs <= now;
        });
      }),
      createMany: vi.fn(async ({ data }: { data: Array<Record<string, unknown>> }) => {
        let count = 0;
        for (const item of data) {
          // Simulates skipDuplicates against the idempotencyKey unique key.
          const duplicate =
            rows.some((row) => row.idempotencyKey === item.idempotencyKey) ||
            (overrides.existingOutbox as { idempotencyKey?: string } | null)?.idempotencyKey ===
              item.idempotencyKey;
          if (duplicate) continue;
          rows.push({ id: `out-${rows.length + 1}`, status: "pending", ...item });
          count += 1;
        }
        return { count };
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: unknown }) => {
        const row = rows.find((candidate) => candidate.id === where.id);
        if (row) Object.assign(row, data);
        return row;
      }),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id?: string; providerHandle?: string; status?: string };
          data: Record<string, unknown>;
        }) => {
          let count = 0;
          for (const row of rows) {
            if (where.id && row.id !== where.id) continue;
            if (where.providerHandle && row.providerHandle !== where.providerHandle) continue;
            if (where.status && row.status !== where.status) continue;
            Object.assign(row, data);
            count += 1;
          }
          return { count };
        },
      ),
    },
  };
  (prisma as { $transaction?: unknown }).$transaction = vi.fn(
    async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma),
  );
  return {
    prisma: prisma as unknown as PrismaClient & typeof prisma,
    messaging,
    events: {
      sendUserMessage: vi.fn(),
      notify: vi.fn(async () => undefined),
    } as unknown as MessagingDeliveryDeps["events"],
    jobs: { enqueue: vi.fn(async () => undefined) },
    sendToThread,
    openDirectThread,
    rows,
  };
}

describe("deliverMessagingOutbound", () => {
  it("mirrors a messaging DM run's bot text to the identity's conversation", async () => {
    const deps = createDeps({});
    await deliverMessagingOutbound(deps, { runId: "run-1" }, context);

    expect(deps.sendToThread).toHaveBeenCalledWith(
      { threadId: "sendblue:dm-1", body: "Hello from your bot" },
      context,
    );
    expect(deps.rows).toEqual([
      expect.objectContaining({
        idempotencyKey: "msg:m-1",
        kind: "dm",
        identityId: "mi-1",
        status: "sent",
        providerHandle: "handle-out-1",
        sourceMessageId: "m-1",
      }),
    ]);
    expect(deps.prisma.messagingIdentity.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { outboundSinceInbound: { increment: 1 } } }),
    );
    expect(deps.prisma.run.updateMany).toHaveBeenCalledWith({
      where: { id: "run-1", trigger: "messaging" },
      data: { messagingMirroredAt: expect.any(Date) },
    });
  });

  it("resolves the DM thread once and caches it when the identity has none", async () => {
    const deps = createDeps({
      identity: { dmThreadId: null },
      messages: [
        { id: "m-1", blocks: [{ kind: "text", text: "first" }] },
        { id: "m-2", blocks: [{ kind: "text", text: "second" }] },
      ],
    });
    await deliverMessagingOutbound(deps, { runId: "run-1" }, context);

    expect(deps.openDirectThread).toHaveBeenCalledTimes(1);
    expect(deps.openDirectThread).toHaveBeenCalledWith("sendblue", "+15551234567", context);
    expect(deps.prisma.messagingIdentity.update).toHaveBeenCalledWith({
      where: { id: "mi-1" },
      data: { dmThreadId: "sendblue:opened:+15551234567" },
    });
    expect(deps.sendToThread).toHaveBeenNthCalledWith(
      1,
      { threadId: "sendblue:opened:+15551234567", body: "first" },
      context,
    );
    expect(deps.sendToThread).toHaveBeenNthCalledWith(
      2,
      { threadId: "sendblue:opened:+15551234567", body: "second" },
      context,
    );
  });

  it("does not mirror a message that already has an outbox row", async () => {
    const deps = createDeps({
      existingOutbox: { id: "out-1", idempotencyKey: "msg:m-1", status: "sent" },
    });
    await deliverMessagingOutbound(deps, { runId: "run-1" }, context);

    expect(deps.rows).toHaveLength(0);
    expect(deps.sendToThread).not.toHaveBeenCalled();
  });

  it("ignores non-messaging runs and runs without a messaging identity", async () => {
    const notMessaging = createDeps({ run: { ...messagingRun, trigger: "user" } });
    await deliverMessagingOutbound(notMessaging, { runId: "run-1" }, context);
    expect(notMessaging.sendToThread).not.toHaveBeenCalled();

    const noIdentity = createDeps({ identity: null });
    await deliverMessagingOutbound(noIdentity, { runId: "run-1" }, context);
    expect(noIdentity.sendToThread).not.toHaveBeenCalled();
  });

  it("holds sendblue DM sends at the consecutive-outbound cap", async () => {
    const deps = createDeps({
      identity: {
        provider: "sendblue",
        outboundSinceInbound: MESSAGING_DM_OUTBOUND_CAP,
      },
    });
    await deliverMessagingOutbound(deps, { runId: "run-1" }, context);

    expect(deps.sendToThread).not.toHaveBeenCalled();
    expect(deps.rows).toEqual([expect.objectContaining({ kind: "dm", status: "pending" })]);
  });

  it("does not apply the sendblue outbound cap to other providers", async () => {
    const deps = createDeps({
      identity: {
        provider: "slack",
        address: "U123",
        outboundSinceInbound: MESSAGING_DM_OUTBOUND_CAP,
      },
    });
    await deliverMessagingOutbound(deps, { runId: "run-1" }, context);

    expect(deps.sendToThread).toHaveBeenCalled();
    expect(deps.rows).toEqual([
      expect.objectContaining({ kind: "dm", status: "sent", providerHandle: "handle-out-1" }),
    ]);
  });

  it("returns a transient send failure to pending and schedules a delayed retry", async () => {
    const deps = createDeps({ sendError: new Error("messaging provider 500") });
    await deliverMessagingOutbound(deps, { runId: "run-1" }, context);

    expect(deps.rows).toEqual([
      expect.objectContaining({
        kind: "dm",
        status: "pending",
        attempts: 1,
        nextAttemptAt: expect.any(Date),
      }),
    ]);
    expect(deps.rows[0]!.providerHandle ?? null).toBeNull();
    expect(deps.jobs.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ name: "messaging.deliver", availableAt: expect.any(Date) }),
    );
  });

  it("skips pending rows whose nextAttemptAt is still in the future", async () => {
    const deps = createDeps({
      run: null,
      outboundRows: [
        {
          id: "out-wait",
          idempotencyKey: "invite:ch-1:mi-1",
          kind: "dm",
          identityId: "mi-1",
          body: "backoff hold",
          status: "pending",
          attempts: 1,
          nextAttemptAt: new Date(Date.now() + 60_000),
          providerHandle: null,
        },
      ],
    });
    await deliverMessagingOutbound(deps, {}, context);

    expect(deps.sendToThread).not.toHaveBeenCalled();
    expect(deps.rows[0]).toEqual(expect.objectContaining({ status: "pending", attempts: 1 }));
  });

  it("drains leftover pending rows without a run id", async () => {
    const deps = createDeps({
      run: null,
      outboundRows: [
        {
          id: "out-9",
          idempotencyKey: "invite:ch-1:mi-1",
          kind: "dm",
          identityId: "mi-1",
          body: "pending earlier",
          status: "pending",
          providerHandle: null,
        },
      ],
    });
    await deliverMessagingOutbound(deps, {}, context);

    expect(deps.sendToThread).toHaveBeenCalledWith(
      { threadId: "sendblue:dm-1", body: "pending earlier" },
      context,
    );
    expect(deps.rows[0]).toEqual(expect.objectContaining({ status: "sent" }));
  });

  it("claims a row before sending so concurrent drains cannot double-send", async () => {
    const deps = createDeps({});
    await deliverMessagingOutbound(deps, { runId: "run-1" }, context);

    const calls = deps.prisma.messagingOutbound.updateMany.mock.calls as Array<
      [{ where?: { status?: string } }]
    >;
    const claimIndex = calls.findIndex(([args]) => args.where?.status === "pending");
    expect(claimIndex).toBeGreaterThanOrEqual(0);
    expect(
      deps.prisma.messagingOutbound.updateMany.mock.invocationCallOrder[claimIndex]!,
    ).toBeLessThan(deps.sendToThread.mock.invocationCallOrder[0]!);
  });

  it("skips the send when another drain won the claim", async () => {
    const deps = createDeps({});
    deps.prisma.messagingOutbound.updateMany = vi.fn(async () => ({
      count: 0,
    })) as unknown as typeof deps.prisma.messagingOutbound.updateMany;
    await deliverMessagingOutbound(deps, { runId: "run-1" }, context);

    expect(deps.sendToThread).not.toHaveBeenCalled();
  });

  it("fails malformed rows instead of re-scanning them forever", async () => {
    const deps = createDeps({
      run: null,
      outboundRows: [
        {
          id: "out-bad",
          idempotencyKey: "broken:1",
          kind: "dm",
          identityId: null,
          body: "nowhere to go",
          status: "pending",
          providerHandle: null,
        },
      ],
    });
    await deliverMessagingOutbound(deps, {}, context);

    expect(deps.sendToThread).not.toHaveBeenCalled();
    expect(deps.rows[0]).toEqual(expect.objectContaining({ status: "failed" }));
  });

  it("does not send a connect invite after the connection was revoked", async () => {
    const deps = createDeps({
      run: null,
      connectionStatus: "revoked",
      outboundRows: [
        {
          id: "out-connect",
          idempotencyKey: "connect:bot-1:bot-9",
          kind: "dm",
          identityId: "mi-1",
          body: "wants to connect. Reply YES to allow, NO to decline.",
          status: "pending",
          providerHandle: null,
        },
      ],
    });
    await deliverMessagingOutbound(deps, {}, context);

    expect(deps.sendToThread).not.toHaveBeenCalled();
    expect(deps.rows[0]).toEqual(expect.objectContaining({ status: "failed" }));
    expect(deps.prisma.$queryRaw).toHaveBeenCalled();
  });

  it("does not send a connect invite when revoke already deleted the claim", async () => {
    const deps = createDeps({
      run: null,
      connectionStatus: "pending",
      outboundRows: [
        {
          id: "out-connect",
          idempotencyKey: "connect:bot-1:bot-9",
          kind: "dm",
          identityId: "mi-1",
          body: "wants to connect. Reply YES to allow, NO to decline.",
          status: "pending",
          providerHandle: null,
        },
      ],
    });
    // After claim, revoke deletes the row before the locked gate runs.
    deps.prisma.messagingOutbound.findUnique = vi.fn(async () => null) as never;
    await deliverMessagingOutbound(deps, {}, context);

    expect(deps.sendToThread).not.toHaveBeenCalled();
  });

  it("still sends a connect invite while the connection is pending", async () => {
    const deps = createDeps({
      run: null,
      connectionStatus: "pending",
      outboundRows: [
        {
          id: "out-connect",
          idempotencyKey: "connect:bot-1:bot-9",
          kind: "dm",
          identityId: "mi-1",
          body: "wants to connect. Reply YES to allow, NO to decline.",
          status: "pending",
          providerHandle: null,
        },
      ],
    });
    await deliverMessagingOutbound(deps, {}, context);

    expect(deps.sendToThread).toHaveBeenCalledWith(
      {
        threadId: "sendblue:dm-1",
        body: "wants to connect. Reply YES to allow, NO to decline.",
      },
      context,
    );
    expect(deps.rows[0]).toEqual(expect.objectContaining({ status: "sent" }));
    expect(deps.prisma.messagingIdentity.update).toHaveBeenCalledWith({
      where: { id: "mi-1" },
      data: { outboundSinceInbound: { increment: 1 } },
    });
  });

  it("does not re-queue a connect invite when the provider send fails", async () => {
    const deps = createDeps({
      run: null,
      connectionStatus: "pending",
      sendError: new Error("provider down"),
      outboundRows: [
        {
          id: "out-connect",
          idempotencyKey: "connect:bot-1:bot-9",
          kind: "dm",
          identityId: "mi-1",
          body: "wants to connect",
          status: "pending",
          providerHandle: null,
          attempts: 0,
        },
      ],
    });
    await deliverMessagingOutbound(deps, {}, context);

    // At-most-once: keep the claim rather than risk a duplicate YES/NO.
    expect(deps.rows[0]).toEqual(expect.objectContaining({ status: "sent" }));
    expect(deps.jobs.enqueue).not.toHaveBeenCalled();
    expect(deps.prisma.messagingIdentity.update).not.toHaveBeenCalled();
  });

  it("does not re-queue a connect invite after a delivery transaction timeout", async () => {
    const deps = createDeps({
      run: null,
      connectionStatus: "pending",
      outboundRows: [
        {
          id: "out-connect",
          idempotencyKey: "connect:bot-1:bot-9",
          kind: "dm",
          identityId: "mi-1",
          body: "wants to connect",
          status: "pending",
          providerHandle: null,
        },
      ],
    });
    (deps.prisma as unknown as { $transaction: unknown }).$transaction = vi.fn(async () => {
      throw new Error("Transaction API error: Transaction already closed");
    });
    await deliverMessagingOutbound(deps, {}, context);

    expect(deps.sendToThread).not.toHaveBeenCalled();
    expect(deps.rows[0]).toEqual(expect.objectContaining({ status: "sent" }));
    expect(deps.jobs.enqueue).not.toHaveBeenCalled();
  });
});

describe("applyMessagingOutboundStatus", () => {
  it("maps terminal statuses onto outbox rows by handle", async () => {
    const deps = createDeps({});
    await applyMessagingOutboundStatus(deps.prisma, {
      type: "status",
      provider: "sendblue",
      handle: "h-1",
      status: "ERROR",
    });
    expect(deps.prisma.messagingOutbound.updateMany).toHaveBeenCalledWith({
      where: { providerHandle: "h-1" },
      data: { status: "failed" },
    });

    await applyMessagingOutboundStatus(deps.prisma, {
      type: "status",
      provider: "sendblue",
      handle: "h-2",
      status: "DELIVERED",
    });
    expect(deps.prisma.messagingOutbound.updateMany).toHaveBeenCalledWith({
      where: { providerHandle: "h-2" },
      data: { status: "sent" },
    });

    await applyMessagingOutboundStatus(deps.prisma, {
      type: "status",
      provider: "sendblue",
      handle: "h-3",
      status: "QUEUED",
    });
    expect(deps.prisma.messagingOutbound.updateMany).toHaveBeenCalledTimes(2);
  });
});

function createChannelDeps(
  overrides: {
    text?: string;
    sourceHop?: number;
    peerBotName?: string | null;
    messages?: unknown[];
  } = {},
) {
  const text = overrides.text ?? "found it";
  const channelRun = {
    id: "run-1",
    botId: "bot-1",
    trigger: "messaging",
    sourceMessage: {
      blocks: [
        {
          kind: "channel_message",
          provider: "sendblue",
          channelId: "ch-1",
          fromAddress: "+15551111111",
          fromLabel: "Alice",
          text: "group hi",
          hop: overrides.sourceHop ?? 0,
        },
      ],
    },
  };
  const posterIdentity = {
    id: "mi-1",
    provider: "sendblue",
    address: "+15551111111",
    dmThreadId: "sendblue:dm-1",
    userId: "user-1",
    spaceId: "ws-1",
    botId: "bot-1",
    outboundSinceInbound: 0,
  };
  const peerIdentity = {
    id: "mi-2",
    provider: "sendblue",
    address: "+15553333333",
    dmThreadId: "sendblue:dm-2",
    userId: "user-2",
    spaceId: "ws-2",
    botId: "bot-2",
    outboundSinceInbound: 0,
  };
  const rows: Array<Record<string, unknown>> = [];
  const contextMessages: Array<Record<string, unknown>> = [];
  const { messaging, sendToThread } = createFakeSurface();
  const sendUserMessage = vi.fn(async () => ({ messageId: "msg-wake", runId: "run-wake", seq: 4 }));
  const notify = vi.fn(async () => undefined);
  const enqueue = vi.fn(async () => undefined);
  const peerBotName = overrides.peerBotName === undefined ? "Helper" : overrides.peerBotName;
  const txMock = {
    thread: { update: vi.fn(async () => ({ nextMessageSeq: 5, nextEventSeq: 10 })) },
    message: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const message = { id: `ctx-${contextMessages.length + 1}`, seq: 4, ...data };
        contextMessages.push(message);
        return message;
      }),
    },
    run: { findUnique: vi.fn(async () => null) },
    event: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: "evt-1",
        ...data,
      })),
    },
  };
  const prisma = {
    run: {
      findUnique: vi.fn(async () => channelRun),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    message: {
      findMany: vi.fn(
        async () => overrides.messages ?? [{ id: "m-1", blocks: [{ kind: "text", text }] }],
      ),
      findUnique: vi.fn(async () => null),
    },
    messagingIdentity: {
      findUnique: vi.fn(async ({ where }: { where: { botId?: string; id?: string } }) => {
        if (where.botId === "bot-1" || where.id === "mi-1") return posterIdentity;
        if (where.botId === "bot-2" || where.id === "mi-2") return peerIdentity;
        return null;
      }),
      update: vi.fn(async () => posterIdentity),
    },
    messagingChannel: {
      findUnique: vi.fn(async () => ({
        id: "ch-1",
        provider: "sendblue",
        threadId: "sendblue:grp-1",
        name: "Family",
        introPostedAt: null,
      })),
    },
    messagingChannelMember: {
      findMany: vi.fn(async () => [
        {
          id: "mm-2",
          channelId: "ch-1",
          address: "+15553333333",
          identityId: "mi-2",
          status: "approved",
        },
      ]),
    },
    messagingOutbound: {
      findMany: vi.fn(async ({ where }: { where?: { status?: string; OR?: unknown[] } } = {}) => {
        const now = Date.now();
        return rows.filter((row) => {
          if (where?.status && row.status !== where.status) return false;
          if (!where?.OR) return row.status === "pending";
          const next = row.nextAttemptAt;
          if (next == null) return true;
          const nextMs = next instanceof Date ? next.getTime() : new Date(String(next)).getTime();
          return nextMs <= now;
        });
      }),
      createMany: vi.fn(async ({ data }: { data: Array<Record<string, unknown>> }) => {
        for (const item of data)
          rows.push({ id: `out-${rows.length + 1}`, status: "pending", ...item });
        return { count: data.length };
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: unknown }) => {
        const row = rows.find((candidate) => candidate.id === where.id);
        if (row) Object.assign(row, data);
        return row;
      }),
      updateMany: vi.fn(
        async ({ where, data }: { where: { id?: string; status?: string }; data: unknown }) => {
          let count = 0;
          for (const row of rows) {
            if (where.id && row.id !== where.id) continue;
            if (where.status && row.status !== where.status) continue;
            Object.assign(row, data);
            count += 1;
          }
          return { count };
        },
      ),
    },
    user: { findUnique: vi.fn(async () => ({ id: "user-1", name: "Alice Owner" })) },
    bot: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        where.id === "bot-1"
          ? { id: "bot-1", name: "Assistant" }
          : peerBotName
            ? { id: "bot-2", name: peerBotName }
            : null,
      ),
    },
    thread: { findFirst: vi.fn(async () => ({ id: "thread-2" })) },
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(txMock)),
  };
  return {
    prisma: prisma as unknown as PrismaClient & typeof prisma,
    messaging,
    events: { sendUserMessage, notify } as unknown as MessagingDeliveryDeps["events"],
    jobs: { enqueue },
    sendToThread,
    sendUserMessage,
    notify,
    enqueue,
    rows,
    contextMessages,
    txMock,
  };
}

describe("deliverMessagingOutbound channel runs", () => {
  it("posts the bot reply to the group with owner attribution and fans it out to peers", async () => {
    const deps = createChannelDeps();
    await deliverMessagingOutbound(deps, { runId: "run-1" }, context);

    expect(deps.sendToThread).toHaveBeenCalledWith(
      { threadId: "sendblue:grp-1", body: "Alice's agent: found it" },
      context,
    );
    expect(deps.rows).toEqual([
      expect.objectContaining({
        idempotencyKey: "msg:m-1",
        kind: "group",
        threadId: "sendblue:grp-1",
        status: "sent",
      }),
    ]);
    // peer context: appended without a run, carrying the next hop
    expect(deps.contextMessages).toEqual([
      expect.objectContaining({
        threadId: "thread-2",
        role: "user",
        clientNonce: "messaging-peer:m-1:bot-2",
        blocks: [
          {
            kind: "channel_message",
            provider: "sendblue",
            channelId: "ch-1",
            fromAddress: "+15551111111",
            fromLabel: "Alice's agent",
            text: "found it",
            hop: 1,
          },
        ],
      }),
    ]);
    expect(deps.sendUserMessage).not.toHaveBeenCalled();
    expect(deps.enqueue).not.toHaveBeenCalled();
  });

  it("wakes an @-mentioned peer bot with a run", async () => {
    const deps = createChannelDeps({ text: "@Helper what do you think?" });
    await deliverMessagingOutbound(deps, { runId: "run-1" }, context);

    expect(deps.sendUserMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        spaceId: "ws-2",
        threadId: "thread-2",
        botId: "bot-2",
        trigger: "messaging",
        clientNonce: "messaging-peer:m-1:bot-2",
      }),
    );
    expect(deps.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ name: "run.continue", payload: { runId: "run-wake" } }),
    );
    expect(deps.contextMessages).toHaveLength(0);
  });

  it("wakes an @-mentioned peer even when the casing differs", async () => {
    const deps = createChannelDeps({ text: "@helper ping" });
    await deliverMessagingOutbound(deps, { runId: "run-1" }, context);

    expect(deps.sendUserMessage).toHaveBeenCalledWith(
      expect.objectContaining({ botId: "bot-2", clientNonce: "messaging-peer:m-1:bot-2" }),
    );
  });

  it("does not wake anyone when the hop budget is exhausted", async () => {
    const deps = createChannelDeps({ text: "@Helper again?", sourceHop: 6 });
    await deliverMessagingOutbound(deps, { runId: "run-1" }, context);

    expect(deps.sendUserMessage).not.toHaveBeenCalled();
    expect(deps.enqueue).not.toHaveBeenCalled();
    // still delivered as context, with the clamped hop recorded
    expect(deps.contextMessages[0]).toEqual(
      expect.objectContaining({ clientNonce: "messaging-peer:m-1:bot-2" }),
    );
  });
});

describe("deliverMessagingOutbound transient failure retry", () => {
  it("marks the row failed only once the attempt budget is exhausted", async () => {
    const deps = createDeps({
      run: null,
      sendError: new Error("messaging provider 500"),
      outboundRows: [
        {
          id: "out-9",
          idempotencyKey: "msg:m-9",
          kind: "dm",
          identityId: "mi-1",
          body: "fourth failure",
          status: "pending",
          providerHandle: null,
          attempts: MESSAGING_OUTBOUND_MAX_ATTEMPTS - 1,
        },
      ],
    });
    await deliverMessagingOutbound(deps, {}, context);

    expect(deps.rows).toEqual([
      expect.objectContaining({ status: "failed", attempts: MESSAGING_OUTBOUND_MAX_ATTEMPTS }),
    ]);
    expect(deps.jobs.enqueue).not.toHaveBeenCalled();
  });
});

describe("deliverMessagingOutbound retry enqueue failure", () => {
  it("propagates the enqueue failure so the job queue retries the drain", async () => {
    const deps = createDeps({});
    deps.sendToThread.mockRejectedValueOnce(new Error("messaging provider 500"));
    deps.jobs.enqueue.mockRejectedValueOnce(new Error("queue down"));

    // A swallowed enqueue failure would strand the row in pending forever:
    // no job reconciler reclaims messaging_outbound rows.
    await expect(deliverMessagingOutbound(deps, { runId: "run-1" }, context)).rejects.toThrow(
      "queue down",
    );
    expect(deps.rows).toEqual([
      expect.objectContaining({
        kind: "dm",
        status: "pending",
        attempts: 1,
        nextAttemptAt: expect.any(Date),
      }),
    ]);

    // The delayed messaging.deliver job fires at nextAttemptAt: make the row due.
    deps.rows[0]!.nextAttemptAt = new Date(Date.now() - 1);
    await deliverMessagingOutbound(deps, { runId: "run-1" }, context);
    expect(deps.sendToThread).toHaveBeenCalledTimes(2);
    expect(deps.rows).toEqual([
      expect.objectContaining({ kind: "dm", status: "sent", providerHandle: "handle-out-1" }),
    ]);
  });
});
