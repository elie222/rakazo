import type { AdapterContext, MessagingSurface } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatSdkMessagingSurface, MessagingSendError } from "./chat-sdk-surface.js";
import type { MessagingDeliveryDeps } from "./messaging-delivery.js";
import {
  applyMessagingOutboundStatus,
  deliverMessagingOutbound,
  MESSAGING_DM_OUTBOUND_CAP,
  MESSAGING_OUTBOUND_MAX_ATTEMPTS,
} from "./messaging-delivery.js";
import { messagingPlatformsFromEnv } from "./messaging-platforms.js";

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
      { provider: "sendblue", capabilities: { direct: true, groups: true, receipt: "typing" } },
      {
        provider: "telegram",
        capabilities: { direct: true, groups: false, receipt: null, files: true },
      },
    ],
    handleWebhook: () => null,
    onInbound: () => undefined,
    sendToThread,
    openDirectThread,
    acknowledge: vi.fn(async () => undefined),
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
  blockedBot?: string;
  artifacts?: Array<Record<string, unknown>>;
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
    artifact: {
      findFirst: vi.fn(
        async ({ where }: { where: { id: string; spaceId: string } }) =>
          (overrides.artifacts ?? []).find(
            (artifact) => artifact.id === where.id && artifact.spaceId === where.spaceId,
          ) ?? null,
      ),
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
    $queryRaw: vi.fn(async (query: TemplateStringsArray) =>
      query.join("").includes("FROM bots")
        ? ["bot-1", "bot-2"].map((id) => ({
            id,
            spaceId: id,
            crossSpaceCommunication: id !== overrides.blockedBot,
            archivedAt: null,
          }))
        : overrides.connectionStatus === null
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
        const found = rows.filter((row) => {
          if (where?.status && row.status !== where.status) return false;
          if (!where?.OR) return row.status === "pending";
          const next = row.nextAttemptAt;
          if (next == null) return true;
          const nextMs = next instanceof Date ? next.getTime() : new Date(String(next)).getTime();
          return nextMs <= now;
        });
        // The drain reads in send order (orderBy createdAt).
        return found.every((row) => row.createdAt instanceof Date)
          ? found.sort((a, b) => (a.createdAt as Date).getTime() - (b.createdAt as Date).getTime())
          : found;
      }),
      // Earlier undelivered part of the same reply (see hasUndeliveredEarlierPart).
      findFirst: vi.fn(
        async ({
          where,
        }: {
          where: {
            sourceMessageId: string;
            createdAt: { lt: Date };
            OR: Array<{ status: string; updatedAt?: { gt: Date } }>;
          };
        }) =>
          rows.find((row) => {
            if (row.sourceMessageId !== where.sourceMessageId) return false;
            if (!((row.createdAt as Date) < where.createdAt.lt)) return false;
            return where.OR.some((condition) =>
              condition.status === "pending"
                ? row.status === "pending"
                : row.status === "sent" &&
                  row.providerHandle == null &&
                  ((row.updatedAt as Date | undefined) ?? new Date()) > condition.updatedAt!.gt,
            );
          }) ?? null,
      ),
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
    artifacts: { get: vi.fn(async (storageKey: string) => new TextEncoder().encode(storageKey)) },
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

  it("ignores in-app runs and runs without a messaging identity", async () => {
    const notMessaging = createDeps({ run: { ...messagingRun, trigger: "user" } });
    await deliverMessagingOutbound(notMessaging, { runId: "run-1" }, context);
    expect(notMessaging.sendToThread).not.toHaveBeenCalled();

    const noIdentity = createDeps({ identity: null });
    await deliverMessagingOutbound(noIdentity, { runId: "run-1" }, context);
    expect(noIdentity.sendToThread).not.toHaveBeenCalled();
  });

  it("mirrors delegated bot_message replies to the linked DM", async () => {
    const deps = createDeps({ run: { ...messagingRun, trigger: "bot_message" } });
    await deliverMessagingOutbound(deps, { runId: "run-1" }, context);
    expect(deps.sendToThread).toHaveBeenCalledWith(
      { threadId: "sendblue:dm-1", body: "Hello from your bot" },
      context,
    );
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
    transport?: string;
    peerBotName?: string | null;
    blockedBot?: string;
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
          ...(overrides.transport ? { transport: overrides.transport } : {}),
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
      // Earlier undelivered part of the same reply (see hasUndeliveredEarlierPart).
      findFirst: vi.fn(
        async ({
          where,
        }: {
          where: {
            sourceMessageId: string;
            createdAt: { lt: Date };
            OR: Array<{ status: string; updatedAt?: { gt: Date } }>;
          };
        }) =>
          rows.find((row) => {
            if (row.sourceMessageId !== where.sourceMessageId) return false;
            if (!((row.createdAt as Date) < where.createdAt.lt)) return false;
            return where.OR.some((condition) =>
              condition.status === "pending"
                ? row.status === "pending"
                : row.status === "sent" &&
                  row.providerHandle == null &&
                  ((row.updatedAt as Date | undefined) ?? new Date()) > condition.updatedAt!.gt,
            );
          }) ?? null,
      ),
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
    $queryRaw: vi.fn(async () =>
      ["bot-1", "bot-2"].map((id) => ({
        id,
        spaceId: id,
        crossSpaceCommunication: id !== overrides.blockedBot,
        archivedAt: null,
      })),
    ),
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
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ ...txMock, $queryRaw: prisma.$queryRaw }),
    ),
  };
  return {
    prisma: prisma as unknown as PrismaClient & typeof prisma,
    messaging,
    events: { sendUserMessage, notify } as unknown as MessagingDeliveryDeps["events"],
    jobs: { enqueue },
    artifacts: { get: vi.fn() },
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
  it("keeps privately answered runs out of the group and peer fan-out on retries", async () => {
    const deps = createChannelDeps({
      messages: [
        {
          id: "ask-1",
          blocks: [{ kind: "ask", text: "Details?", status: "answered", answer: "Private detail" }],
        },
        { id: "reply-1", blocks: [{ kind: "text", text: "Reply containing private detail" }] },
      ],
    });
    await deliverMessagingOutbound(deps, { runId: "run-1" }, context);
    await deliverMessagingOutbound(deps, { runId: "run-1" }, context);
    expect(deps.rows).toEqual([]);
    expect(deps.sendToThread).not.toHaveBeenCalled();
    expect(deps.contextMessages).toEqual([]);
    expect(deps.sendUserMessage).not.toHaveBeenCalled();
  });

  it("can still publish a group reply alongside an unanswered ask", async () => {
    const deps = createChannelDeps({
      messages: [
        { id: "ask-1", blocks: [{ kind: "ask", text: "Details?", status: "pending" }] },
        { id: "reply-1", blocks: [{ kind: "text", text: "Public update" }] },
      ],
    });
    await deliverMessagingOutbound(deps, { runId: "run-1" }, context);
    expect(deps.sendToThread).toHaveBeenCalledWith(
      { threadId: "sendblue:grp-1", body: "Alice's agent: Public update" },
      context,
    );
  });

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

  it("preserves source transport on peer fan-out blocks", async () => {
    const deps = createChannelDeps({ transport: "SMS" });
    await deliverMessagingOutbound(deps, { runId: "run-1" }, context);

    expect(deps.contextMessages).toEqual([
      expect.objectContaining({
        clientNonce: "messaging-peer:m-1:bot-2",
        blocks: [
          expect.objectContaining({
            kind: "channel_message",
            provider: "sendblue",
            transport: "SMS",
            text: "found it",
            hop: 1,
          }),
        ],
      }),
    ]);
  });

  it("preserves source transport when waking an @-mentioned peer", async () => {
    const deps = createChannelDeps({ text: "@Helper what do you think?", transport: "RCS" });
    await deliverMessagingOutbound(deps, { runId: "run-1" }, context);

    expect(deps.sendUserMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        botId: "bot-2",
        blocks: [
          expect.objectContaining({
            kind: "channel_message",
            transport: "RCS",
          }),
        ],
      }),
    );
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
        crossSpaceSenderBotId: "bot-1",
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

describe("deliverMessagingOutbound send failure classification", () => {
  it("fails a permanently rejected row at once instead of retrying it", async () => {
    const deps = createDeps({
      sendError: new MessagingSendError(new Error("channel_not_found"), {
        permanent: true,
        retryAfterMs: null,
      }),
    });
    await deliverMessagingOutbound(deps, { runId: "run-1" }, context);

    expect(deps.rows).toEqual([expect.objectContaining({ status: "failed", attempts: 1 })]);
    expect(deps.jobs.enqueue).not.toHaveBeenCalled();
  });

  it("waits at least the provider's retry-after before the next attempt", async () => {
    const deps = createDeps({
      sendError: new MessagingSendError(new Error("rate limited"), {
        permanent: false,
        retryAfterMs: 30_000,
      }),
    });
    const before = Date.now();
    await deliverMessagingOutbound(deps, { runId: "run-1" }, context);

    const retryAt = deps.rows[0]!.nextAttemptAt as Date;
    expect(deps.rows[0]).toEqual(expect.objectContaining({ status: "pending", attempts: 1 }));
    expect(retryAt.getTime()).toBeGreaterThanOrEqual(before + 30_000);
    expect(deps.jobs.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ name: "messaging.deliver", availableAt: retryAt }),
    );
  });
});

describe("deliverMessagingOutbound conversation order", () => {
  const whatsapp = { provider: "whatsapp", address: "15551234567", dmThreadId: "whatsapp:p:1" };
  const part = (letter: string) => letter.repeat(3000);
  const longReply = [part("a"), part("b"), part("c")].join("\n\n");

  it.each([
    whatsapp,
    { provider: "telegram", address: "123", dmThreadId: "telegram:123" },
    { provider: "telegram-work", address: "123", dmThreadId: "telegram-work:123" },
  ])("queues a long $provider reply as one row per message-sized part", async (identity) => {
    const deps = createDeps({
      identity,
      messages: [{ id: "m-1", blocks: [{ kind: "text", text: longReply }] }],
    });
    await deliverMessagingOutbound(deps, { runId: "run-1" }, context);

    expect(deps.rows.map((row) => [row.idempotencyKey, row.body, row.status])).toEqual([
      ["msg:m-1", part("a"), "sent"],
      ["msg:m-1:2", part("b"), "sent"],
      ["msg:m-1:3", part("c"), "sent"],
    ]);
    expect(deps.rows.every((row) => row.sourceMessageId === "m-1")).toBe(true);
  });

  it("re-sends only the parts that failed, in order", async () => {
    const deps = createDeps({
      identity: whatsapp,
      messages: [{ id: "m-1", blocks: [{ kind: "text", text: longReply }] }],
    });
    deps.sendToThread
      .mockResolvedValueOnce({ handle: "wamid.1" })
      .mockRejectedValueOnce(new Error("WhatsApp API error"));
    await deliverMessagingOutbound(deps, { runId: "run-1" }, context);

    // The third part waits behind the failed second one.
    expect(deps.rows.map((row) => row.status)).toEqual(["sent", "pending", "pending"]);
    expect(deps.rows[2]!.attempts ?? 0).toBe(0);

    deps.rows[1]!.nextAttemptAt = new Date(Date.now() - 1);
    await deliverMessagingOutbound(deps, { runId: "run-1" }, context);

    expect(deps.sendToThread.mock.calls.map((call) => (call as unknown[])[0])).toEqual(
      [part("a"), part("b"), part("b"), part("c")].map((body) => ({
        threadId: "whatsapp:p:1",
        body,
      })),
    );
    expect(deps.rows.map((row) => row.status)).toEqual(["sent", "sent", "sent"]);
  });

  it.each([
    ["in flight in another drain", "sent", new Date(), false],
    ["abandoned mid-send long ago", "sent", new Date(Date.now() - 10 * 60_000), true],
    ["permanently failed", "failed", new Date(), true],
  ] as const)(
    "a later part whose first part is %s is sent=%s",
    async (_label, status, updatedAt, sent) => {
      const part = (id: string, key: string, offset: number, extra: Record<string, unknown>) => ({
        id,
        idempotencyKey: key,
        kind: "dm",
        identityId: "mi-1",
        body: id,
        sourceMessageId: "m-1",
        providerHandle: null,
        attempts: 0,
        nextAttemptAt: null,
        createdAt: new Date(1_000 + offset),
        ...extra,
      });
      const deps = createDeps({
        run: null,
        identity: whatsapp,
        outboundRows: [
          part("p-1", "msg:m-1", 0, { status, updatedAt }),
          part("p-2", "msg:m-1:2", 1, { status: "pending" }),
        ],
      });
      await deliverMessagingOutbound(deps, {}, context);

      expect(deps.sendToThread).toHaveBeenCalledTimes(sent ? 1 : 0);
      expect(deps.rows[1]!.status).toBe(sent ? "sent" : "pending");
    },
  );

  it("holds later rows to a conversation while an earlier one waits out its backoff", async () => {
    const pendingRow = (id: string, body: string, nextAttemptAt: Date | null) => ({
      id,
      idempotencyKey: `msg:${id}`,
      kind: "dm",
      identityId: "mi-1",
      body,
      status: "pending",
      attempts: nextAttemptAt ? 1 : 0,
      nextAttemptAt,
      providerHandle: null,
    });
    const deps = createDeps({
      run: null,
      outboundRows: [
        pendingRow("out-1", "first", new Date(Date.now() + 60_000)),
        pendingRow("out-2", "second", null),
        {
          ...pendingRow("out-3", "elsewhere", null),
          identityId: null,
          kind: "group",
          threadId: "sendblue:grp",
        },
      ],
    });
    await deliverMessagingOutbound(deps, {}, context);

    expect(deps.sendToThread).toHaveBeenCalledExactlyOnceWith(
      { threadId: "sendblue:grp", body: "elsewhere" },
      context,
    );
    expect(deps.rows.map((row) => row.status)).toEqual(["pending", "pending", "sent"]);
  });
});

describe("WhatsApp rendered outbound delivery", () => {
  afterEach(() => vi.unstubAllGlobals());

  const deliver = async (body: string, failSend?: number) => {
    const sends: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: string, init: RequestInit) => {
        const payload = JSON.parse(String(init.body)) as { text: { body: string } };
        sends.push(payload.text.body);
        if (sends.length === failSend) {
          return Response.json({ error: { message: "temporary error", code: 1 } }, { status: 500 });
        }
        return Response.json({ messages: [{ id: `wamid.${sends.length}` }] });
      }),
    );
    const messaging = new ChatSdkMessagingSurface(
      messagingPlatformsFromEnv({
        whatsappAccessToken: "test-token",
        whatsappPhoneNumberId: "123",
        whatsappAppSecret: "test-secret",
        whatsappVerifyToken: "test-verify",
      }),
    );
    const deps = createDeps({
      identity: {
        provider: "whatsapp",
        address: "15551234567",
        dmThreadId: "whatsapp:123:15551234567",
      },
      messages: [{ id: "m-1", blocks: [{ kind: "text", text: body }] }],
    });
    const run = () => deliverMessagingOutbound({ ...deps, messaging }, { runId: "run-1" }, context);
    await run();
    return { deps, sends, run };
  };
  const intact = (text: string) => text.length <= 4096 && !/\p{Cs}/u.test(text);

  it("splits before Markdown rendering pushes an emoji across the limit", async () => {
    // Rendering expands this auto-link so the emoji would begin at UTF-16 offset 4095.
    const link = `www.${"a".repeat(2000)}.test`;
    const body = `${link} ${"x".repeat(65)}😀zzz`;
    expect(body.length).toBeLessThan(4096);

    const { deps, sends, run } = await deliver(body, 2);

    expect(deps.rows).toHaveLength(2);
    expect(sends).toHaveLength(2);
    expect(sends.every(intact)).toBe(true);
    expect(sends.join(" ")).toContain("😀zzz");
    expect(deps.rows.map((row) => row.status)).toEqual(["sent", "pending"]);

    deps.rows[1]!.nextAttemptAt = new Date(Date.now() - 1);
    await run();

    expect(sends.slice(2)).toEqual([sends[1]]);
    expect(deps.rows.map((row) => row.status)).toEqual(["sent", "sent"]);
  });

  it("sends a table that renders past the limit as one request per queued part", async () => {
    const rows = Array.from({ length: 200 }, (_, i) => `| ${i} | x | 😀 |`);
    const body = [
      "| n | text | mood |",
      "| - | - | - |",
      `| - | ${"w".repeat(40)} | - |`,
      ...rows,
    ].join("\n");
    expect(body.length).toBeLessThan(4096);

    const { deps, sends } = await deliver(body);

    expect(deps.rows.length).toBeGreaterThan(1);
    expect(sends).toHaveLength(deps.rows.length);
    expect(sends.every(intact)).toBe(true);
    expect(deps.rows.every((row) => row.status === "sent")).toBe(true);
  });
});

describe("deliverMessagingOutbound attachments", () => {
  const telegram = { provider: "telegram", address: "123", dmThreadId: "telegram:123" };
  const artifacts = [
    {
      id: "art-1",
      spaceId: "ws-1",
      userId: "user-1",
      name: "chart.png",
      mimeType: "image/png",
      storageKey: "key-1",
    },
    {
      id: "art-2",
      spaceId: "ws-1",
      userId: "user-1",
      name: "report.pdf",
      mimeType: "application/pdf",
      storageKey: "key-2",
    },
  ];
  const reply = {
    id: "m-1",
    blocks: [
      { kind: "text", text: "Here you go" },
      { kind: "image", artifactId: "art-1", mimeType: "image/png", name: "chart.png" },
      {
        kind: "file",
        artifactId: "art-2",
        mimeType: "application/pdf",
        name: "report.pdf",
        size: 5,
      },
    ],
  };
  const bytes = (storageKey: string) => new TextEncoder().encode(storageKey);
  const sentBodies = (deps: ReturnType<typeof createDeps>) =>
    deps.sendToThread.mock.calls.map((call) => {
      const request = (call as unknown[])[0] as { body: string; attachment?: { name: string } };
      return request.attachment ? `file:${request.attachment.name}` : request.body;
    });

  it("sends a reply's image and file after its text, one row each", async () => {
    const deps = createDeps({ identity: telegram, messages: [reply], artifacts });
    await deliverMessagingOutbound(deps, { runId: "run-1" }, context);

    expect(deps.sendToThread.mock.calls.map((call) => (call as unknown[])[0])).toEqual([
      { threadId: "telegram:123", body: "Here you go" },
      {
        threadId: "telegram:123",
        body: "",
        attachment: { name: "chart.png", mimeType: "image/png", data: bytes("key-1") },
      },
      {
        threadId: "telegram:123",
        body: "",
        attachment: { name: "report.pdf", mimeType: "application/pdf", data: bytes("key-2") },
      },
    ]);
    expect(deps.rows.map((row) => [row.idempotencyKey, row.status])).toEqual([
      ["msg:m-1", "sent"],
      ["msg:m-1:file:art-1", "sent"],
      ["msg:m-1:file:art-2", "sent"],
    ]);
    // Bytes come from the artifact store, read in the artifact's own Space.
    expect(deps.artifacts.get).toHaveBeenCalledWith(
      "key-1",
      expect.objectContaining({ spaceId: "ws-1", userId: "user-1" }),
    );
  });

  it("sends a reply that is only a file", async () => {
    const deps = createDeps({
      identity: telegram,
      messages: [{ id: "m-1", blocks: [reply.blocks[1]] }],
      artifacts,
    });
    await deliverMessagingOutbound(deps, { runId: "run-1" }, context);

    expect(sentBodies(deps)).toEqual(["file:chart.png"]);
  });

  it("keeps text-only delivery on platforms that cannot send files", async () => {
    const deps = createDeps({ messages: [reply], artifacts });
    await deliverMessagingOutbound(deps, { runId: "run-1" }, context);

    expect(deps.sendToThread).toHaveBeenCalledExactlyOnceWith(
      { threadId: "sendblue:dm-1", body: "Here you go" },
      context,
    );
    expect(deps.rows).toHaveLength(1);
    expect(deps.artifacts.get).not.toHaveBeenCalled();
  });

  it("retries a failed file without sending the text again", async () => {
    const deps = createDeps({ identity: telegram, messages: [reply], artifacts });
    deps.sendToThread
      .mockResolvedValueOnce({ handle: "text-1" })
      .mockRejectedValueOnce(new Error("Telegram 500"));
    await deliverMessagingOutbound(deps, { runId: "run-1" }, context);

    // The second file waits behind the failed first one.
    expect(deps.rows.map((row) => row.status)).toEqual(["sent", "pending", "pending"]);

    deps.rows[1]!.nextAttemptAt = new Date(Date.now() - 1);
    await deliverMessagingOutbound(deps, { runId: "run-1" }, context);

    expect(sentBodies(deps)).toEqual([
      "Here you go",
      "file:chart.png",
      "file:chart.png",
      "file:report.pdf",
    ]);
    expect(deps.rows.map((row) => row.status)).toEqual(["sent", "sent", "sent"]);
  });

  it("queues a short notice once a file's attempts run out, without repeating the text", async () => {
    const fileRow = {
      id: "out-2",
      idempotencyKey: "msg:m-1:file:art-1",
      kind: "dm",
      identityId: "mi-1",
      body: "",
      sourceMessageId: "m-1",
      status: "pending",
      attempts: MESSAGING_OUTBOUND_MAX_ATTEMPTS - 1,
      nextAttemptAt: null,
      providerHandle: null,
      createdAt: new Date(1_001),
    };
    const deps = createDeps({
      run: null,
      identity: telegram,
      artifacts,
      outboundRows: [
        {
          ...fileRow,
          id: "out-1",
          idempotencyKey: "msg:m-1",
          body: "Here you go",
          status: "sent",
          providerHandle: "text-1",
          createdAt: new Date(1_000),
        },
        fileRow,
      ],
    });
    deps.sendToThread.mockRejectedValueOnce(new Error("Telegram 500"));
    await deliverMessagingOutbound(deps, {}, context);

    expect(deps.rows.map((row) => [row.idempotencyKey, row.status])).toEqual([
      ["msg:m-1", "sent"],
      ["msg:m-1:file:art-1", "failed"],
      ["msg:m-1:file:art-1:notice", "pending"],
    ]);
    expect(deps.rows[2]).toEqual(
      expect.objectContaining({ kind: "dm", identityId: "mi-1", sourceMessageId: "m-1" }),
    );
    expect(deps.jobs.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ name: "messaging.deliver" }),
    );

    await deliverMessagingOutbound(deps, {}, context);
    expect(sentBodies(deps)).toEqual(["file:chart.png", 'Could not send "chart.png".']);
    expect(deps.rows.map((row) => row.status)).toEqual(["sent", "failed", "sent"]);
  });

  it("sends the notice in the file's place, before a later reply already queued", async () => {
    const deps = createDeps({
      run: null,
      identity: telegram,
      artifacts,
      outboundRows: [
        {
          id: "out-1",
          idempotencyKey: "msg:m-1:file:art-1",
          kind: "dm",
          identityId: "mi-1",
          body: "",
          sourceMessageId: "m-1",
          status: "pending",
          attempts: MESSAGING_OUTBOUND_MAX_ATTEMPTS - 1,
          nextAttemptAt: null,
          providerHandle: null,
          createdAt: new Date(1_000),
        },
        {
          id: "out-2",
          idempotencyKey: "msg:m-2",
          kind: "dm",
          identityId: "mi-1",
          body: "Later reply",
          sourceMessageId: "m-2",
          status: "pending",
          attempts: 0,
          nextAttemptAt: null,
          providerHandle: null,
          createdAt: new Date(2_000),
        },
      ],
    });
    deps.sendToThread.mockRejectedValueOnce(new Error("Telegram 500"));
    await deliverMessagingOutbound(deps, {}, context);
    // The failure and its notice are saved together.
    expect(deps.prisma.$transaction).toHaveBeenCalledTimes(1);

    await deliverMessagingOutbound(deps, {}, context);
    expect(sentBodies(deps)).toEqual([
      "file:chart.png",
      'Could not send "chart.png".',
      "Later reply",
    ]);
  });

  it("drops a file whose artifact is gone or belongs to another Space", async () => {
    const deps = createDeps({
      identity: telegram,
      messages: [reply],
      artifacts: [{ ...artifacts[0]!, spaceId: "ws-2" }],
    });
    await deliverMessagingOutbound(deps, { runId: "run-1" }, context);

    expect(sentBodies(deps)).toEqual(["Here you go"]);
    expect(deps.rows.map((row) => row.status)).toEqual(["sent", "failed", "failed"]);
    expect(deps.artifacts.get).not.toHaveBeenCalled();
  });
});

describe("cross-space group reply isolation", () => {
  it.each(["bot-1", "bot-2"])(
    "does not send history or wake a peer when %s is blocked",
    async (blockedBot) => {
      const deps = createChannelDeps({ blockedBot, text: "@Helper private reply" });
      await deliverMessagingOutbound(deps, { runId: "run-1" }, context);
      expect(deps.contextMessages).toHaveLength(0);
      expect(deps.sendUserMessage).not.toHaveBeenCalled();
    },
  );
});

it("drops a queued connection invite after opt-out", async () => {
  const deps = createDeps({
    run: null,
    blockedBot: "bot-1",
    connectionStatus: "pending",
    outboundRows: [
      {
        id: "invite",
        idempotencyKey: "connect:bot-1:bot-2",
        kind: "dm",
        identityId: "mi-1",
        body: "Connection invite",
        status: "pending",
        providerHandle: null,
      },
    ],
  });
  await deliverMessagingOutbound(deps, {}, context);
  expect(deps.sendToThread).not.toHaveBeenCalled();
});

describe("accepted outbound bookkeeping failures", () => {
  const cases = [
    ["group", "handle"],
    ["intro", "handle"],
    ["invite", "counter"],
    ["text", "handle"],
    ["text", "counter"],
    ["attachment", "handle"],
    ["attachment", "counter"],
  ] as const;

  function pending(kind: string) {
    return createDeps({
      identity: { provider: "telegram", dmThreadId: "telegram:123" },
      outboundRows: [
        {
          id: "out-accepted",
          idempotencyKey:
            kind === "invite"
              ? "connect:bot-1:bot-9"
              : kind === "attachment"
                ? "msg:m-1:file:art-1"
                : "msg:m-1",
          sourceMessageId: "m-1",
          kind: kind === "group" || kind === "intro" ? kind : "dm",
          identityId: kind === "group" || kind === "intro" ? null : "mi-1",
          threadId: kind === "group" || kind === "intro" ? "telegram:group" : null,
          body: kind === "attachment" ? "" : "Hello",
          status: "pending",
          attempts: 0,
          providerHandle: null,
          nextAttemptAt: null,
          createdAt: new Date(1_000),
        },
      ],
      artifacts: [
        {
          id: "art-1",
          spaceId: "ws-1",
          userId: "user-1",
          name: "chart.png",
          mimeType: "image/png",
          storageKey: "chart",
        },
      ],
    });
  }

  it.each(cases)("does not resend accepted %s after a %s save failure", async (kind, failure) => {
    const deps = pending(kind);
    const error = new Error("bookkeeping unavailable");
    if (failure === "counter") {
      deps.prisma.messagingIdentity.update.mockRejectedValueOnce(error);
    } else if (kind === "group" || kind === "intro") {
      deps.prisma.messagingOutbound.update.mockRejectedValueOnce(error);
    } else {
      const update = deps.prisma.messagingOutbound.updateMany.getMockImplementation()!;
      deps.prisma.messagingOutbound.updateMany
        .mockImplementationOnce(update)
        .mockRejectedValueOnce(error);
    }
    await deliverMessagingOutbound(deps, {}, context);
    // Past every send retry and abandoned-part deadline, the accepted row stays claimed.
    deps.rows[0]!.nextAttemptAt = new Date(0);
    deps.rows[0]!.updatedAt = new Date(0);
    await deliverMessagingOutbound(deps, {}, context);
    expect(deps.sendToThread).toHaveBeenCalledTimes(1);
    expect(deps.rows[0]!.status).toBe("sent");
    expect(deps.rows[0]!.attempts).toBe(0);
    expect(deps.rows[0]!.providerHandle).toBe(failure === "counter" ? "handle-out-1" : null);
    expect(deps.jobs.enqueue).not.toHaveBeenCalled();
    expect(deps.rows).toHaveLength(1);
  });

  it.each(["group", "intro", "text", "attachment"])(
    "still retries %s when the provider fails before acceptance",
    async (kind) => {
      const deps = pending(kind);
      deps.sendToThread.mockRejectedValueOnce(new Error("provider unavailable"));
      await deliverMessagingOutbound(deps, {}, context);
      expect(deps.rows[0]!.status).toBe("pending");
      expect(deps.rows[0]!.attempts).toBe(1);
      expect(deps.jobs.enqueue).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          name: "messaging.deliver",
          availableAt: deps.rows[0]!.nextAttemptAt,
        }),
      );
      deps.rows[0]!.nextAttemptAt = new Date(0);
      await deliverMessagingOutbound(deps, {}, context);
      expect(deps.sendToThread).toHaveBeenCalledTimes(2);
      expect(deps.rows[0]!.status).toBe("sent");
    },
  );
});
