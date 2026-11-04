import { randomUUID } from "node:crypto";
import type { AdapterContext, MessagingSurface } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { asSystem, createDb, provisionMessagingIdentity, runAsSystem } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { deliverMessagingOutbound, mirrorMessagingOutbound } from "./messaging-delivery.js";

const url = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE === "1" && url ? describe.sequential : describe.skip;

const context: AdapterContext = {
  operationId: "op-1",
  traceId: "trace-1",
  spaceId: "ws-1",
  userId: "user-1",
  signal: new AbortController().signal,
};

describePostgres("messaging outbound drain order (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let system: PrismaClient;
  let identity: { userId: string; spaceId: string; botId: string; threadId: string };
  const address = `order-${randomUUID()}`;
  const threadIds: string[] = [];

  beforeAll(async () => {
    db = createDb(url!);
    system = asSystem(db.prisma);
    const provisioned = await runAsSystem("messaging order fixture", () =>
      provisionMessagingIdentity(
        db.prisma,
        { provider: "telegram", address },
        { signupsEnabled: undefined, signupAllowlist: undefined },
      ),
    );
    identity = {
      userId: provisioned.userId,
      spaceId: provisioned.spaceId,
      botId: provisioned.botId,
      threadId: provisioned.threadId,
    };
  });
  afterAll(async () => {
    if (system) {
      await system.messagingOutbound.deleteMany({ where: { threadId: { in: threadIds } } });
      await system.messagingChannel.deleteMany({ where: { threadId: { in: threadIds } } });
      await system.messagingIdentity.deleteMany({ where: { address } });
      await system.organization.deleteMany({ where: { id: identity?.spaceId } });
      await system.user.deleteMany({ where: { id: identity?.userId } });
    }
    if (db) {
      await db.prisma.$disconnect();
      await db.pool.end();
    }
  });

  function fakeSurface() {
    const sendToThread = vi.fn(async () => ({ handle: "handle-out-1" }));
    const messaging: MessagingSurface = {
      describe: () => ({
        id: "fake",
        contractVersion: "1",
        adapterVersion: "0.1.0",
        capabilities: { providers: [] },
      }),
      platforms: () => [],
      handleWebhook: () => null,
      onInbound: () => undefined,
      sendToThread,
      openDirectThread: vi.fn(async () => "fake:dm"),
      acknowledge: vi.fn(async () => undefined),
    };
    return { messaging, sendToThread };
  }

  function makeDeps(prisma: PrismaClient, messaging: MessagingSurface) {
    return {
      prisma,
      messaging,
      events: { sendUserMessage: vi.fn(), notify: vi.fn(async () => undefined) },
      jobs: { enqueue: vi.fn(async () => undefined) },
      artifacts: { get: vi.fn(async () => new Uint8Array()) },
    };
  }

  /** A channel with two mirrored bot replies: A is long (two parts), B short. */
  async function channelWithReplies(threadId: string) {
    const channel = await system.messagingChannel.create({
      data: { provider: "telegram", threadId, name: "Order" },
    });
    const block = [
      {
        kind: "channel_message",
        provider: "telegram",
        channelId: channel.id,
        fromAddress: "111",
        fromLabel: "Alice",
        text: "group hi",
        hop: 0,
      },
    ];
    const runs: Array<{ id: string }> = [];
    for (const reply of [`one ${"x".repeat(4_100)} END-A`, "short reply two"]) {
      const seq = runs.length * 2 + 1;
      const source = await system.message.create({
        data: {
          threadId: identity.threadId,
          seq,
          role: "user",
          blocks: block,
          clientNonce: `order-src-${seq}-${threadId}`,
        },
      });
      const task = await system.task.create({
        data: { ...identity, prompt: "mirror fixture", status: "completed" },
      });
      const run = await system.run.create({
        data: {
          ...identity,
          taskId: task.id,
          status: "completed",
          trigger: "messaging",
          sourceMessageId: source.id,
        },
      });
      await system.message.create({
        data: {
          threadId: identity.threadId,
          seq: seq + 1,
          role: "bot",
          botId: identity.botId,
          runId: run.id,
          blocks: [{ kind: "text", text: reply }],
        },
      });
      runs.push(run);
    }
    return runs;
  }

  it("keeps a group conversation ordered when one createMany wrote equal createdAt values", async () => {
    const threadId = `messaging-delivery-${randomUUID()}`;
    threadIds.push(threadId);
    // One insert without explicit createdAt, as rows written before the
    // per-part timestamps existed: both rows share the same timestamp.
    await system.messagingOutbound.createMany({
      data: [
        { idempotencyKey: `msg:${threadId}:1`, kind: "group", threadId, body: "first post" },
        { idempotencyKey: `msg:${threadId}:2`, kind: "group", threadId, body: "second post" },
      ],
    });
    const inserted = await system.messagingOutbound.findMany({
      where: { threadId },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    expect(inserted).toHaveLength(2);
    expect(inserted[1]!.createdAt.getTime()).toBe(inserted[0]!.createdAt.getTime());

    const { messaging, sendToThread } = fakeSurface();
    const deps = makeDeps(system, messaging);
    let releaseFirst = () => {};
    const firstSend = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    sendToThread.mockImplementationOnce(async () => {
      await firstSend;
      return { handle: "handle-first" };
    });

    const firstDrain = deliverMessagingOutbound(deps, {}, context);
    // The first drain claims the conversation's head and blocks in the send.
    await vi.waitFor(async () => {
      const inFlight = await system.messagingOutbound.findMany({
        where: { threadId, status: "sent", providerHandle: null },
      });
      expect(inFlight).toHaveLength(1);
    });

    // A concurrent drain of the same conversation must wait behind it.
    await deliverMessagingOutbound(deps, {}, context);
    expect(sendToThread).toHaveBeenCalledTimes(1);

    releaseFirst();
    await firstDrain;
    const sent = await system.messagingOutbound.findMany({
      where: { threadId },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    expect(sent.map((row) => row.status)).toEqual(["sent", "sent"]);
    expect(sendToThread.mock.calls.map((call) => (call as unknown[])[0])).toEqual(
      inserted.map((row) => ({ threadId, body: row.body })),
    );
  });

  it("never interleaves two mirrors of one group, not even on a clock tie", async () => {
    const threadId = `messaging-delivery-${randomUUID()}`;
    threadIds.push(threadId);
    const [runA, runB] = await channelWithReplies(threadId);
    const { messaging } = fakeSurface();
    const deps = makeDeps(system, messaging);

    // Both mirrors read the same millisecond: allocation must still give one
    // reply a range entirely after the other's.
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    try {
      await Promise.all([
        mirrorMessagingOutbound(deps, runA!.id),
        mirrorMessagingOutbound(deps, runB!.id),
      ]);
    } finally {
      clock.mockRestore();
    }

    const rows = await system.messagingOutbound.findMany({
      where: { threadId },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    expect(rows).toHaveLength(3);
    const replyB = rows.filter((row) => row.body.includes("two"));
    const replyA = rows.filter((row) => !replyB.includes(row));
    expect(replyA).toHaveLength(2);
    expect(replyB[0]!.createdAt.getTime()).toBeGreaterThan(replyA.at(-1)!.createdAt.getTime());
    // Later tests drain every pending row in the database.
    await system.messagingOutbound.deleteMany({ where: { threadId } });
  });

  it("does not start a send beside an in-flight row when an earlier row lands late", async () => {
    const threadId = `messaging-delivery-${randomUUID()}`;
    threadIds.push(threadId);
    const now = Date.now();
    // The later-ordered row goes out first; the earlier-ordered row becomes
    // visible only afterwards, as a range whose insert committed late.
    await system.messagingOutbound.createMany({
      data: [
        {
          idempotencyKey: `msg:${threadId}:late-head`,
          kind: "group",
          threadId,
          body: "later row",
          createdAt: new Date(now + 5_000),
        },
      ],
    });

    const { messaging, sendToThread } = fakeSurface();
    const deps = makeDeps(system, messaging);
    let releaseSend = () => {};
    const sendGate = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    sendToThread.mockImplementationOnce(async () => {
      await sendGate;
      return { handle: "handle-later" };
    });
    const drain = deliverMessagingOutbound(deps, {}, context);
    await vi.waitFor(() => expect(sendToThread).toHaveBeenCalledTimes(1));

    await system.messagingOutbound.createMany({
      data: [
        {
          idempotencyKey: `msg:${threadId}:early-late`,
          kind: "group",
          threadId,
          body: "earlier row",
          createdAt: new Date(now),
        },
      ],
    });
    await deliverMessagingOutbound(deps, {}, context);
    expect(sendToThread).toHaveBeenCalledTimes(1);

    releaseSend();
    await drain;
    await deliverMessagingOutbound(deps, {}, context);
    const bodies = sendToThread.mock.calls.map(
      (call) => ((call as unknown[])[0] as { body: string }).body,
    );
    expect(bodies).toEqual(["later row", "earlier row"]);
  });
});
