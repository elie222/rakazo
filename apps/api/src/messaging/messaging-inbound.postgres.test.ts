import { randomUUID } from "node:crypto";
import type { MessagingInboundMessage, MessagingSurface } from "@rakazo/adapter-kit";
import { messagingInboundSettleJob, messagingInboundSettleJobKey } from "@rakazo/adapter-kit";
import {
  GraphileJobPublisher,
  MessagingDelivery,
  messagingAttachmentClientNonce,
  sealSettleText,
  settleInboundMessage,
} from "@rakazo/adapters";
import { deferred } from "@rakazo/core/test-async";
import type { PrismaClient } from "@rakazo/db";
import {
  asSystem,
  createDb,
  createThreadEvents,
  provisionMessagingIdentity,
  runAsSystem,
  runAsTenant,
} from "@rakazo/db";
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
      pendingUntil: vi.fn(async () => null),
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
    await vi.waitFor(
      async () => {
        if (!(await condition())) throw new Error(`timed out waiting for ${what}`);
      },
      { interval: 100, timeout: Math.max(0, deadline - performance.now()) },
    );
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

/**
 * A YES answers a connection request only when the newest message the person was sent is that
 * request, confirmed delivered. A request whose send failed, or may have arrived before its send
 * failed, answers nothing, and an older request must not take the YES in its place.
 */
describe.skipIf(!enabled)("connection requests whose send failed (PostgreSQL)", () => {
  const addresses: string[] = [];
  const provisioned: Array<{ userId: string; spaceId: string }> = [];
  let db: ReturnType<typeof createDb>;
  let system: PrismaClient;
  /** While set, every transaction gets this timeout instead of its own. */
  let squeezeMs: number | null = null;
  let squeezed: PrismaClient;
  const jobs = {
    enqueue: vi.fn(async () => undefined),
    enqueueIn: vi.fn(async () => undefined),
    cancel: vi.fn(async () => undefined),
    cancelIn: vi.fn(async () => undefined),
    pendingUntil: vi.fn(async () => null),
  };

  beforeAll(() => {
    db = createDb(databaseUrl!);
    system = asSystem(db.prisma);
    squeezed = new Proxy(system, {
      get(target, key) {
        if (key !== "$transaction") return Reflect.get(target, key);
        const transaction = Reflect.get(target, "$transaction").bind(target) as (
          work: unknown,
          options?: Record<string, unknown>,
        ) => unknown;
        return (work: unknown, options?: Record<string, unknown>) =>
          transaction(work, squeezeMs === null ? options : { ...options, timeout: squeezeMs });
      },
    }) as PrismaClient;
  });

  afterAll(async () => {
    if (!db) return;
    await system.messagingIdentity.deleteMany({ where: { address: { in: addresses } } });
    for (const { userId, spaceId } of provisioned) {
      await system.organization.deleteMany({ where: { id: spaceId } });
      await system.user.deleteMany({ where: { id: userId } });
    }
    await db.prisma.$disconnect();
    await db.pool.end();
  });

  async function provision(name: string) {
    const address = `${name}-${randomUUID()}`;
    addresses.push(address);
    const bot = await runAsSystem("connection fixture", () =>
      provisionMessagingIdentity(db.prisma, { provider: "telegram", address }),
    );
    provisioned.push(bot);
    await system.bot.update({ where: { id: bot.botId }, data: { crossSpaceCommunication: true } });
    const identity = await system.messagingIdentity.update({
      where: { botId: bot.botId },
      data: { dmThreadId: `telegram:${address}` },
    });
    return { ...identity, threadId: bot.threadId };
  }

  type Identity = Awaited<ReturnType<typeof provision>>;

  function requestConnection(requester: Identity, target: Identity) {
    return system.agentConnection.create({
      data: { requesterBotId: requester.botId, targetBotId: target.botId, status: "pending" },
    });
  }

  /** A message the person was sent and saw, a minute ago. */
  function delivered(target: Identity, idempotencyKey: string, body: string) {
    return system.messagingOutbound.create({
      data: {
        idempotencyKey,
        kind: "dm",
        identityId: target.id,
        body,
        status: "sent",
        providerHandle: `h-${randomUUID()}`,
        createdAt: new Date(Date.now() - 60_000),
      },
    });
  }

  function delivery(sendToThread: () => Promise<{ handle: string }>) {
    return new MessagingDelivery({
      prisma: squeezed,
      messaging: { platforms: () => [], sendToThread } as unknown as MessagingSurface,
      events: createThreadEvents(system),
      jobs,
      artifacts: { get: vi.fn() },
    });
  }

  function sendRequest(
    sender: MessagingDelivery,
    requester: Identity,
    target: Identity,
  ): Promise<void> {
    return runAsSystem("connection request", () =>
      sender.record({ identityId: target.id }, [
        {
          idempotencyKey: `connect:${requester.botId}:${target.botId}`,
          kind: "dm",
          identityId: target.id,
          body: "Scout wants to connect. Reply YES to allow, NO to decline.",
        },
      ]),
    );
  }

  /** The person replies YES; returns the message it became, if it reached the bot as one. */
  async function replyYes(target: Identity) {
    const recorder = delivery(async () => ({ handle: "unused" }));
    const inbound = createMessagingInboundHandler({
      prisma: system,
      events: createThreadEvents(system),
      jobs,
      delivery: { recordIn: recorder.recordIn.bind(recorder), send: vi.fn(async () => undefined) },
      sandbox: {} as never,
      provision: vi.fn(),
      openSignup: false,
    });
    const handle = `in-${randomUUID()}`;
    const address = target.dmThreadId!.slice("telegram:".length);
    await runAsSystem("the person's YES", () =>
      inbound({
        type: "message",
        provider: "telegram",
        handle,
        threadId: target.dmThreadId!,
        isDirect: true,
        from: address,
        fromLabel: null,
        channelName: null,
        participants: [address],
        content: "YES",
        mediaUrl: null,
      }),
    );
    return system.message.findFirst({
      where: { clientNonce: `messaging:telegram:${handle}` },
      select: { threadId: true, blocks: true },
    });
  }

  const statusOf = async (id: string) =>
    (await system.agentConnection.findUniqueOrThrow({ where: { id }, select: { status: true } }))
      .status;

  it("does not let a YES after a failed send approve that request", async () => {
    const target = await provision("target");
    const requester = await provision("requester");
    const connection = await requestConnection(requester, target);
    await delivered(target, `msg:earlier-${randomUUID()}`, "Shall I book the table?");
    const sendToThread = vi.fn(async (): Promise<{ handle: string }> => {
      throw new Error("provider down");
    });
    await sendRequest(delivery(sendToThread), requester, target);
    expect(sendToThread).toHaveBeenCalledOnce();

    const yes = await replyYes(target);
    expect(await statusOf(connection.id)).toBe("pending");
    expect(
      await system.messagingOutbound.findMany({
        where: { identityId: target.id, idempotencyKey: { startsWith: "connect:" } },
        select: { status: true },
      }),
    ).toEqual([{ status: "failed" }]);
    // The YES reached the bot as an ordinary message instead.
    expect(yes).toEqual({ threadId: target.threadId, blocks: [{ kind: "text", text: "YES" }] });
  });

  it("does not let an older request take a YES meant for a newer one that arrived but failed", async () => {
    const target = await provision("target");
    const attacker = await provision("attacker");
    const trusted = await provision("trusted");
    const attackerConnection = await requestConnection(attacker, target);
    await delivered(
      target,
      `connect:${attacker.botId}:${target.botId}`,
      "Mallory wants to connect. Reply YES to allow, NO to decline.",
    );
    const trustedConnection = await requestConnection(trusted, target);
    // The provider accepts the trusted request, but only after its send's transaction timed out.
    const reached = deferred();
    const sendToThread = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      reached.resolve();
      return { handle: "h-trusted" };
    });
    squeezeMs = 500;
    try {
      await sendRequest(delivery(sendToThread), trusted, target);
    } finally {
      squeezeMs = null;
    }
    await reached.promise;
    expect(
      await system.messagingOutbound.findUniqueOrThrow({
        where: { idempotencyKey: `connect:${trusted.botId}:${target.botId}` },
        select: { status: true },
      }),
    ).toEqual({ status: "failed" });

    const yes = await replyYes(target);
    expect({
      attacker: await statusOf(attackerConnection.id),
      trusted: await statusOf(trustedConnection.id),
    }).toEqual({ attacker: "pending", trusted: "pending" });
    expect(yes).toEqual({ threadId: target.threadId, blocks: [{ kind: "text", text: "YES" }] });
  });
});

/**
 * The API stopped while a direct message's files were still downloading: the message's backup
 * job settles it with what was stored, marks the rest, and tells the sender once.
 */
describe.skipIf(!enabled)("settling a direct message after a restart (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let system: PrismaClient;
  let identity: Awaited<ReturnType<typeof provisionMessagingIdentity>> & { id: string };
  const jobs = {
    enqueue: vi.fn(async () => undefined),
    enqueueIn: vi.fn(async () => undefined),
    cancel: vi.fn(async () => undefined),
    cancelIn: vi.fn(async () => undefined),
    pendingUntil: vi.fn(async () => null),
  };

  beforeAll(async () => {
    db = createDb(databaseUrl!, { encryptContent: true });
    system = asSystem(db.prisma);
    const address = `settle-${randomUUID()}`;
    const provisioned = await runAsSystem("settle fixture", () =>
      provisionMessagingIdentity(db.prisma, { provider: "test", address }),
    );
    const row = await system.messagingIdentity.update({
      where: { botId: provisioned.botId },
      data: { dmThreadId: `test:${address}` },
      select: { id: true },
    });
    identity = { ...provisioned, id: row.id };
  });

  afterAll(async () => {
    if (!db) return;
    if (identity) {
      await system.messagingIdentity.deleteMany({ where: { userId: identity.userId } });
      await system.organization.deleteMany({ where: { id: identity.spaceId } });
      await system.user.deleteMany({ where: { id: identity.userId } });
    }
    await db.prisma.$disconnect();
    await db.pool.end();
  });

  it("settle job posts the message with unfinished files marked and replies to the sender", async () => {
    const sendToThread = vi.fn(async () => ({ handle: `h-${randomUUID()}` }));
    const delivery = new MessagingDelivery({
      prisma: db.prisma,
      messaging: { platforms: () => [], sendToThread } as unknown as MessagingSurface,
      events: createThreadEvents(db.prisma),
      jobs,
      artifacts: { get: vi.fn() },
    });
    const handle = `in-${randomUUID()}`;
    const job = { provider: "test", handle, identityId: identity.id };
    const text = await runAsSystem("seal the settle text", () =>
      sealSettleText(db.prisma, identity.spaceId, job, "make a short of these"),
    );
    // The job queue's table holds only the sealed text.
    expect(text).toMatch(/^rkz1:/);
    expect(text).not.toContain("make a short");
    const payload = {
      ...job,
      text,
      attachments: [{ name: "clip.mov", mimeType: "video/quicktime" }],
    };
    const settle = () =>
      runAsTenant(identity, () =>
        settleInboundMessage(
          { prisma: db.prisma, events: createThreadEvents(db.prisma), jobs, delivery },
          payload,
        ),
      );
    await settle();
    // A second run of the job, as after a retry, changes nothing.
    await settle();

    expect(
      await system.message.findMany({
        where: { threadId: identity.threadId, role: "user" },
        select: { clientNonce: true, blocks: true },
      }),
    ).toEqual([
      {
        clientNonce: `messaging:test:${handle}`,
        blocks: [
          {
            kind: "text",
            text: "make a short of these\n[file: clip.mov (unavailable: not received)]",
          },
        ],
      },
    ]);
    expect(
      await system.messagingOutbound.findMany({
        where: { identityId: identity.id },
        select: { kind: true, body: true },
      }),
    ).toEqual([{ kind: "dm", body: "Some files couldn't be received." }]);
    expect(sendToThread).toHaveBeenCalledOnce();
  });

  it("settle job posts the file that was stored and marks the one that was not", async () => {
    const sendToThread = vi.fn(async () => ({ handle: `h-${randomUUID()}` }));
    const delivery = new MessagingDelivery({
      prisma: db.prisma,
      messaging: { platforms: () => [], sendToThread } as unknown as MessagingSurface,
      events: createThreadEvents(db.prisma),
      jobs,
      artifacts: { get: vi.fn() },
    });
    const handle = `in-${randomUUID()}`;
    // The first file was stored before the process stopped; the second was still downloading.
    const photo = await system.artifact.create({
      data: {
        spaceId: identity.spaceId,
        userId: identity.userId,
        botId: identity.botId,
        name: "photo.jpg",
        mimeType: "image/jpeg",
        size: 3,
        hash: "hash-photo",
        storageKey: `storage-${randomUUID()}`,
        clientNonce: messagingAttachmentClientNonce("test", handle, 0),
      },
    });
    const job = { provider: "test", handle, identityId: identity.id };
    const payload = {
      ...job,
      text: await runAsSystem("seal the settle text", () =>
        sealSettleText(db.prisma, identity.spaceId, job, ""),
      ),
      attachments: [
        { name: "photo.jpg", mimeType: "image/jpeg" },
        { name: "clip.mov", mimeType: "video/quicktime" },
      ],
    };
    await runAsTenant(identity, () =>
      settleInboundMessage(
        { prisma: db.prisma, events: createThreadEvents(db.prisma), jobs, delivery },
        payload,
      ),
    );

    expect(
      await system.message.findMany({
        where: { threadId: identity.threadId, clientNonce: `messaging:test:${handle}` },
        select: { blocks: true },
      }),
    ).toEqual([
      {
        blocks: [
          { kind: "text", text: "[file: clip.mov (unavailable: not received)]" },
          { kind: "image", artifactId: photo.id, name: "photo.jpg", mimeType: "image/jpeg" },
        ],
      },
    ]);
    expect(
      await system.messagingOutbound.findMany({
        where: { identityId: identity.id, idempotencyKey: `files-not-received:test:${handle}` },
        select: { body: true },
      }),
    ).toEqual([{ body: "Some files couldn't be received." }]);
  });

  it("settle job says why each missing file is missing, those past the cap included", async () => {
    const delivery = new MessagingDelivery({
      prisma: db.prisma,
      messaging: {
        platforms: () => [],
        sendToThread: vi.fn(async () => ({ handle: `h-${randomUUID()}` })),
      } as unknown as MessagingSurface,
      events: createThreadEvents(db.prisma),
      jobs,
      artifacts: { get: vi.fn() },
    });
    const handle = `in-${randomUUID()}`;
    const job = { provider: "test", handle, identityId: identity.id };
    const payload = {
      ...job,
      text: await runAsSystem("seal the settle text", () =>
        sealSettleText(db.prisma, identity.spaceId, job, ""),
      ),
      attachments: [
        { name: "big.mov", mimeType: "video/quicktime", size: 11 },
        { name: "setup.exe", mimeType: "application/x-msdownload", size: 1 },
        { name: "clip.mov", mimeType: "video/quicktime" },
        { name: "photo.jpg", mimeType: "image/jpeg", size: 3 },
        // Past the cap of four: never downloaded, still listed.
        { name: "extra.jpg", mimeType: "image/jpeg", size: 3 },
      ],
    };
    await runAsTenant(identity, () =>
      settleInboundMessage(
        {
          prisma: db.prisma,
          events: createThreadEvents(db.prisma),
          jobs,
          delivery,
          maxUploadSizeBytes: 10,
        },
        payload,
      ),
    );

    expect(
      await system.message.findMany({
        where: { threadId: identity.threadId, clientNonce: `messaging:test:${handle}` },
        select: { blocks: true },
      }),
    ).toEqual([
      {
        blocks: [
          {
            kind: "text",
            text: [
              "[file: big.mov (unavailable: too large)]",
              "[file: setup.exe (unavailable: unsupported type)]",
              "[file: clip.mov (unavailable: not received)]",
              "[file: photo.jpg (unavailable: not received)]",
              "[file: extra.jpg (unavailable: not received)]",
            ].join("\n"),
          },
        ],
      },
    ]);
    expect(
      await system.messagingOutbound.findMany({
        where: { identityId: identity.id, idempotencyKey: `files-not-received:test:${handle}` },
        select: { body: true },
      }),
    ).toEqual([{ body: "Some files couldn't be received." }]);
  });

  it("settle job posts a message a stop quieted without starting a turn", async () => {
    const delivery = new MessagingDelivery({
      prisma: db.prisma,
      messaging: { platforms: () => [], sendToThread: vi.fn() } as unknown as MessagingSurface,
      events: createThreadEvents(db.prisma),
      jobs,
      artifacts: { get: vi.fn() },
    });
    const handle = `in-${randomUUID()}`;
    const job = { provider: "test", handle, identityId: identity.id };
    const runsBefore = await system.run.count({ where: { botId: identity.botId } });
    jobs.enqueue.mockClear();
    await runAsTenant(identity, () =>
      settleInboundMessage(
        { prisma: db.prisma, events: createThreadEvents(db.prisma), jobs, delivery },
        {
          ...job,
          text: "here is the clip",
          attachments: [],
          quiet: true,
        },
      ),
    );

    expect(
      await system.message.findMany({
        where: { threadId: identity.threadId, clientNonce: `messaging:test:${handle}` },
        select: { blocks: true, runId: true },
      }),
    ).toEqual([{ blocks: [{ kind: "text", text: "here is the clip" }], runId: null }]);
    expect(await system.run.count({ where: { botId: identity.botId } })).toBe(runsBefore);
    expect(jobs.enqueue).not.toHaveBeenCalled();
  });

  it("puts a text behind its sender's message that only a backup job still holds", async () => {
    const publisher = new GraphileJobPublisher(db.pool);
    const earlier = `in-${randomUUID()}`;
    const later = `in-${randomUUID()}`;
    const keys = [
      messagingInboundSettleJobKey("test", earlier),
      messagingInboundSettleJobKey("test", later),
    ];
    // The earlier file message's process stopped mid-download: its job is due in an hour.
    const queuedAt = new Date(Date.now() + 60 * 60_000);
    const row = async (key: string) =>
      (
        await db.pool.query<{ run_at: Date; queue_name: string }>(
          "select run_at, queue_name from graphile_worker.jobs where key = $1",
          [key],
        )
      ).rows[0];
    try {
      await publisher.enqueue(
        messagingInboundSettleJob(
          {
            provider: "test",
            handle: earlier,
            identityId: identity.id,
            text: "",
            attachments: [{ name: "clip.mov", mimeType: "video/quicktime" }],
          },
          queuedAt,
        ),
      );
      const inbound = createMessagingInboundHandler({
        prisma: db.prisma,
        events: createThreadEvents(db.prisma),
        jobs: publisher,
        delivery: { recordIn: vi.fn(), send: vi.fn(async () => undefined) },
        sandbox: {} as never,
        provision: vi.fn(),
        openSignup: false,
      });
      const address = (
        await system.messagingIdentity.findUniqueOrThrow({ where: { id: identity.id } })
      ).address;
      await runAsSystem("test inbound", () =>
        inbound({
          type: "message",
          provider: "test",
          handle: later,
          threadId: `test:${address}`,
          isDirect: true,
          from: address,
          fromLabel: null,
          channelName: null,
          participants: [],
          content: "and make it short",
          mediaUrl: null,
        }),
      );

      // Its own job follows the earlier one in the sender's queue, due just after it.
      await vi.waitFor(async () =>
        expect((await row(keys[1]!))?.run_at.getTime()).toBe(queuedAt.getTime() + 1),
      );
      expect((await row(keys[1]!))?.queue_name).toBe(`messaging.inbound:${identity.id}`);
      expect((await row(keys[0]!))?.run_at.getTime()).toBe(queuedAt.getTime());
      expect(
        await system.message.count({
          where: { threadId: identity.threadId, clientNonce: `messaging:test:${later}` },
        }),
      ).toBe(0);
    } finally {
      await db.pool.query("delete from graphile_worker._private_jobs where key = any($1)", [keys]);
      await publisher.close();
    }
  });
});
