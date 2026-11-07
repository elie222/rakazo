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
  let identityId: string;
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
    identityId = (await system.messagingIdentity.findUnique({ where: { botId: identity.botId } }))!
      .id;
  });
  afterAll(async () => {
    if (system) {
      await system.messagingOutbound.deleteMany({ where: { threadId: { in: threadIds } } });
      // DM rows carry the identity, not a thread.
      if (identityId) {
        await system.messagingOutbound.deleteMany({ where: { identityId } });
      }
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

    // Both mirrors read the same millisecond: whichever wins the allocation
    // lock first, its rows must stay contiguous and clear of the other's.
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
    const owner = (row: (typeof rows)[number]) => (row.body.includes("two") ? 2 : 1);
    const firstOf = (reply: 1 | 2) => rows.findIndex((row) => owner(row) === reply);
    const lastOf = (reply: 1 | 2) => rows.map(owner).lastIndexOf(reply);
    // Each reply's parts form one contiguous block in send order.
    expect(lastOf(1) - firstOf(1)).toBe(1);
    expect(lastOf(2)).toBe(firstOf(2));
    // And the two blocks do not overlap.
    expect(firstOf(2) > lastOf(1) || firstOf(1) > lastOf(2)).toBe(true);
    const earlier = rows.filter((row) => owner(row) === (firstOf(1) < firstOf(2) ? 1 : 2));
    const later = rows.filter((row) => owner(row) === (firstOf(1) < firstOf(2) ? 2 : 1));
    expect(later[0]!.createdAt.getTime()).toBeGreaterThan(earlier.at(-1)!.createdAt.getTime());
    // Later tests drain every pending row in the database.
    await system.messagingOutbound.deleteMany({ where: { threadId } });
  });

  /**
   * A run mirrored to the DM identity: a messaging run whose source carries no
   * channel block, or a delegated bot_message run with no source at all.
   */
  async function dmRunWithReply(trigger: "messaging" | "bot_message", reply: string, seq: number) {
    const source =
      trigger === "messaging"
        ? await system.message.create({
            data: {
              threadId: identity.threadId,
              seq,
              role: "user",
              blocks: [{ kind: "text", text: "dm hi" }],
              clientNonce: `dm-src-${seq}-${address}`,
            },
          })
        : null;
    const task = await system.task.create({
      data: { ...identity, prompt: "mirror fixture", status: "completed" },
    });
    const run = await system.run.create({
      data: {
        ...identity,
        taskId: task.id,
        status: "completed",
        trigger,
        ...(source ? { sourceMessageId: source.id } : {}),
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
    return run;
  }

  it("never interleaves two mirrors of one DM identity, not even on a clock tie", async () => {
    // Seq stays clear of the group fixture's rows in the same thread.
    const runA = await dmRunWithReply("messaging", `one ${"x".repeat(4_100)} END-A`, 201);
    const runB = await dmRunWithReply("bot_message", `two ${"y".repeat(4_100)} END-B`, 203);
    const { messaging } = fakeSurface();
    const deps = makeDeps(system, messaging);

    // Both mirrors read the same millisecond: whichever wins the allocation
    // lock first, its rows must stay contiguous and clear of the other's.
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    try {
      await Promise.all([
        mirrorMessagingOutbound(deps, runA.id),
        mirrorMessagingOutbound(deps, runB.id),
      ]);
    } finally {
      clock.mockRestore();
    }

    const rows = await system.messagingOutbound.findMany({
      where: { identityId },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    expect(rows).toHaveLength(4);
    // The fillers (x for the first reply, y for the second) mark every part.
    const owner = (row: (typeof rows)[number]) => (row.body.includes("y") ? 2 : 1);
    const firstOf = (reply: 1 | 2) => rows.findIndex((row) => owner(row) === reply);
    const lastOf = (reply: 1 | 2) => rows.map(owner).lastIndexOf(reply);
    // Each reply's parts form one contiguous block in send order.
    expect(lastOf(1) - firstOf(1)).toBe(1);
    expect(lastOf(2) - firstOf(2)).toBe(1);
    // And the two blocks do not overlap.
    expect(firstOf(2) > lastOf(1) || firstOf(1) > lastOf(2)).toBe(true);
    const earlier = rows.filter((row) => owner(row) === (firstOf(1) < firstOf(2) ? 1 : 2));
    const later = rows.filter((row) => owner(row) === (firstOf(1) < firstOf(2) ? 2 : 1));
    expect(later[0]!.createdAt.getTime()).toBeGreaterThan(earlier.at(-1)!.createdAt.getTime());
    // Later tests drain every pending row in the database.
    await system.messagingOutbound.deleteMany({ where: { identityId } });
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

  it("does not claim beside a row that committed between the check and the claim", async () => {
    const threadId = `messaging-delivery-${randomUUID()}`;
    threadIds.push(threadId);
    await system.messagingChannel.create({
      data: { provider: "telegram", threadId, name: "Order" },
    });
    await system.messagingOutbound.createMany({
      data: [
        {
          idempotencyKey: `msg:${threadId}:reply`,
          kind: "group",
          threadId,
          body: "reply row",
          createdAt: new Date(Date.now() + 10_000),
        },
      ],
    });

    const { messaging, sendToThread } = fakeSurface();
    const deps = makeDeps(system, messaging);
    let releaseIntroSend = () => {};
    const introSend = new Promise<void>((resolve) => {
      releaseIntroSend = resolve;
    });
    sendToThread.mockImplementationOnce(async () => {
      await introSend;
      return { handle: "handle-intro" };
    });

    // Between the first drain's blocker check and its claim of the reply, the
    // intro writer (not under the allocation lock) commits an earlier row and
    // a second drain picks it up and goes in flight.
    const realTransaction = system.$transaction.bind(system);
    const realUpdateMany = system.messagingOutbound.updateMany.bind(system.messagingOutbound);
    let drainB: Promise<void> | null = null;
    let injected = false;
    const inject = async () => {
      if (injected) return;
      injected = true;
      await system.messagingOutbound.createMany({
        data: [
          {
            idempotencyKey: `intro:${threadId}`,
            kind: "intro",
            threadId,
            body: "intro row",
            createdAt: new Date(Date.now() + 5_000),
          },
        ],
      });
      drainB = deliverMessagingOutbound(deps, {}, context);
      await vi.waitFor(() => expect(sendToThread).toHaveBeenCalledTimes(1));
    };
    const prismaA = Object.create(system) as PrismaClient;
    prismaA.$transaction = (async (fn: unknown, options?: unknown) => {
      await inject();
      return realTransaction(fn as Parameters<typeof realTransaction>[0], options as never);
    }) as PrismaClient["$transaction"];
    const outboundA = Object.create(system.messagingOutbound) as PrismaClient["messagingOutbound"];
    (outboundA as unknown as { updateMany: unknown }).updateMany = ((args: never) =>
      inject().then(() => realUpdateMany(args))) as PrismaClient["messagingOutbound"]["createMany"];
    (prismaA as unknown as { messagingOutbound: unknown }).messagingOutbound = outboundA;
    const depsA = makeDeps(prismaA, messaging);

    await deliverMessagingOutbound(depsA, {}, context);
    // The intro is on the wire; the reply's claim saw it and waited.
    expect(sendToThread).toHaveBeenCalledTimes(1);
    const statuses = await system.messagingOutbound.findMany({
      where: { threadId },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    expect(statuses.map((row) => [row.body, row.status])).toEqual([
      ["intro row", "sent"],
      ["reply row", "pending"],
    ]);

    releaseIntroSend();
    await drainB;
    await deliverMessagingOutbound(deps, {}, context);
    const sent = await system.messagingOutbound.findMany({
      where: { threadId },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    expect(sent.map((row) => row.status)).toEqual(["sent", "sent"]);
    expect(
      sendToThread.mock.calls.map((call) => ((call as unknown[])[0] as { body: string }).body),
    ).toEqual(["intro row", "reply row"]);
  });
});
