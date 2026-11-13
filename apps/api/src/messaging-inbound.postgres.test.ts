import type { MessagingInboundMessage } from "@rakazo/adapter-kit";
import { MessagingDelivery } from "@rakazo/adapters";
import type { PrismaClient } from "@rakazo/db";
import { createDb, createThreadEvents, runAsSystem } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createMessagingInboundHandler } from "./messaging-inbound.js";

const databaseUrl = process.env.DATABASE_URL;
const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(databaseUrl);

/** One deadline for every poll of a barrier, inside the transaction's 20s budget. */
const BARRIER_POLL_BUDGET_MS = 4_000;

/**
 * Two group events of one channel processed out of order, as a webhook retry and the
 * event it retried produce them. Roster handling must be atomic with the roster's own
 * version, or an older handler that passed the version check can sweep members a newer
 * handler has just settled.
 */
describe.skipIf(!enabled)("group roster versioning under concurrency (PostgreSQL)", () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const ids = {
    organizationId: `roster-org-${suffix}`,
    spaceId: `roster-space-${suffix}`,
    userId: `roster-user-${suffix}`,
    threadId: `roster-thread-${suffix}`,
    channelId: `roster-channel-${suffix}`,
  };
  const sender = "+155500000001";
  const member = "+155500000002";
  const olderAt = new Date("2026-11-04T10:01:00.000Z");
  const newerAt = new Date("2026-11-04T10:02:00.000Z");
  let prisma: PrismaClient;
  let db: ReturnType<typeof createDb>;
  let sideDb: ReturnType<typeof createDb>;
  let handle: (event: MessagingInboundMessage) => Promise<void>;

  beforeAll(async () => {
    db = createDb(databaseUrl!);
    prisma = db.prisma;
    // Two events can sit in transactions at once; give them room to outlive a barrier.
    const unhurried = new Proxy(prisma, {
      get(target, key) {
        if (key !== "$transaction") return Reflect.get(target, key);
        const transaction = Reflect.get(target, "$transaction").bind(target) as (
          work: unknown,
          options?: Record<string, unknown>,
        ) => unknown;
        return (work: unknown, options?: Record<string, unknown>) =>
          transaction(work, { timeout: 20_000, ...options });
      },
    }) as PrismaClient;
    const jobs = {
      enqueue: vi.fn(async () => undefined),
      enqueueIn: vi.fn(async () => undefined),
      cancel: vi.fn(async () => undefined),
      cancelIn: vi.fn(async () => undefined),
    };
    const recorder = new MessagingDelivery({
      prisma: unhurried,
      messaging: {} as never,
      events: createThreadEvents(unhurried),
      jobs,
      artifacts: { get: vi.fn() },
    });
    const inbound = createMessagingInboundHandler({
      prisma: unhurried,
      events: createThreadEvents(unhurried),
      jobs,
      delivery: { recordIn: recorder.recordIn.bind(recorder), send: vi.fn(async () => undefined) },
      sandbox: {
        execute: vi.fn(async function* () {
          yield { type: "exit", code: 0 };
        }),
        releaseScreen: vi.fn().mockResolvedValue(undefined),
      } as never,
      provision: vi.fn(),
      openSignup: false,
      signupPolicy: { signupsEnabled: undefined, signupAllowlist: undefined },
    });
    handle = (event) => runAsSystem("test inbound", () => inbound(event));
    sideDb = createDb(databaseUrl!, { poolMax: 4 });
    await runAsSystem("test fixture", async () => {
      await prisma.organization.create({
        data: {
          id: ids.organizationId,
          name: "Roster",
          slug: ids.organizationId,
          createdAt: new Date(),
        },
      });
      await prisma.space.create({
        data: { id: ids.spaceId, organizationId: ids.organizationId, name: "General" },
      });
      await prisma.user.create({
        data: {
          id: ids.userId,
          name: ids.userId,
          email: `${ids.userId}@rakazo.test`,
          emailVerified: false,
        },
      });
      await prisma.messagingChannel.create({
        data: { id: ids.channelId, provider: "test", threadId: ids.threadId },
      });
      await prisma.messagingChannelMember.createMany({
        data: [
          { channelId: ids.channelId, address: sender, identityId: null, status: "invited" },
          { channelId: ids.channelId, address: member, identityId: null, status: "approved" },
        ],
      });
    });
  });

  afterAll(async () => {
    if (!db) return;
    await runAsSystem("test cleanup", async () => {
      await prisma.organization.deleteMany({ where: { id: ids.organizationId } });
      await prisma.user.deleteMany({ where: { id: ids.userId } });
    });
    await Promise.allSettled([
      sideDb.prisma.$disconnect(),
      sideDb.pool.end(),
      prisma.$disconnect(),
      db.pool.end(),
    ]);
  });

  /** Pids of sessions waiting on a lock `holder` holds, proven by PostgreSQL itself. */
  const blockedPidsOn = (holder: number) =>
    sideDb.pool
      .query<{ pid: number }>(
        "SELECT pid FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND pg_blocking_pids(pid) @> ARRAY[$1::int]",
        [holder],
      )
      .then(({ rows }) => rows.map((row) => row.pid));

  async function waitUntil(
    condition: () => Promise<boolean>,
    what: string,
    deadline: number,
  ): Promise<void> {
    while (performance.now() < deadline) {
      if (await condition()) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`timed out waiting for ${what}`);
  }

  const event = (handleId: string, roster: string[], rosterAt: Date): MessagingInboundMessage => ({
    type: "message",
    provider: "test",
    handle: handleId,
    threadId: ids.threadId,
    isDirect: false,
    from: sender,
    fromLabel: null,
    channelName: null,
    participants: roster,
    rosterAt,
    content: "hello group",
    mediaUrl: null,
  });

  it("an older roster cannot sweep a member a newer handler has already settled", async () => {
    const holder = await sideDb.pool.connect();
    const ops: Array<Promise<unknown>> = [];
    const track = (op: Promise<unknown>) => {
      ops.push(
        op.then(
          () => undefined,
          () => undefined,
        ),
      );
      return op;
    };
    try {
      // The older handler must pause past its roster check; a lock on the member's
      // row parks its sweep there, provably inside the handler's transaction.
      await holder.query("BEGIN");
      await holder.query(
        'SELECT id FROM messaging_channel_members WHERE "channelId" = $1 AND address = $2 FOR UPDATE',
        [ids.channelId, member],
      );
      const { rows: own } = await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      const deadline = performance.now() + BARRIER_POLL_BUDGET_MS;

      const older = track(handle(event("older", [sender], olderAt)));
      const olderPid = await waitUntil(
        async () => {
          const pids = (await blockedPidsOn(own[0]!.pid)).filter((pid) => pid !== own[0]!.pid);
          return pids.length > 0;
        },
        "the older handler's sweep",
        deadline,
      ).then(async () => (await blockedPidsOn(own[0]!.pid)).find((pid) => pid !== own[0]!.pid));
      const newer = track(handle(event("newer", [sender, member], newerAt)));
      const newerSettled = newer.then(
        () => true,
        () => true,
      );
      // Either the newer handler runs to completion (nothing held it) or it queues on
      // the older handler's channel lock; both prove where each handler stands.
      await waitUntil(
        () =>
          Promise.race([newerSettled, blockedPidsOn(olderPid!).then((pids) => pids.length > 0)]),
        "the newer handler to settle or queue",
        deadline,
      );
      await holder.query("ROLLBACK");
      await Promise.all([older, newer]);
    } finally {
      await holder.query("ROLLBACK").catch(() => undefined);
      holder.release();
      await Promise.allSettled(ops);
    }

    const settled = await runAsSystem("test assertion", async () => {
      const channel = await prisma.messagingChannel.findUniqueOrThrow({
        where: { id: ids.channelId },
        select: { rosterSeenAt: true },
      });
      const row = await prisma.messagingChannelMember.findUniqueOrThrow({
        where: { channelId_address: { channelId: ids.channelId, address: member } },
        select: { status: true },
      });
      return { channel, row };
    });
    expect(settled.channel.rosterSeenAt).toEqual(newerAt);
    // The older roster's sweep may land first, but the newer handler then re-invites;
    // what must never survive is the member swept to left after the newer roster won.
    expect(settled.row.status).toBe("invited");
  });
});
