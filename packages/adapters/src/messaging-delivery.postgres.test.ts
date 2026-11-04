import { randomUUID } from "node:crypto";
import type { AdapterContext, MessagingSurface } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { asSystem, createDb } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { deliverMessagingOutbound } from "./messaging-delivery.js";

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
  const threadIds: string[] = [];

  beforeAll(async () => {
    db = createDb(url!);
    system = asSystem(db.prisma);
  });
  afterAll(async () => {
    if (system)
      await system.messagingOutbound.deleteMany({ where: { threadId: { in: threadIds } } });
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
    const deps = {
      prisma: system,
      messaging,
      events: { sendUserMessage: vi.fn(), notify: vi.fn(async () => undefined) },
      jobs: { enqueue: vi.fn(async () => undefined) },
      artifacts: { get: vi.fn(async () => new Uint8Array()) },
    };
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
});
