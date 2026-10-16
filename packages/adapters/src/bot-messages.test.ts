import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import {
  currentBotMessageHop,
  loadBotMessageContext,
  messageBot,
  parseMessageBotTargetEffectRequest,
  prepareMessageBotTarget,
  returnBotMessageOutcome,
} from "./bot-messages.js";
import type { ExecutorDeps } from "./executor.js";

const run = {
  id: "run-1",
  spaceId: "workspace-1",
  threadId: "thread-sender",
  botId: "bot-sender",
  userId: "user-1",
  sourceMessageId: null as string | null,
};
const sender = { id: "bot-sender", name: "Researcher" };

function crossSpaceMemberships(
  targetSpaceId = "space-target",
  targetSpaceName = "Research",
  deletingAt: Date | null = null,
) {
  return [
    {
      spaceId: run.spaceId,
      userId: run.userId,
      organizationId: "org-1",
      space: { id: run.spaceId, name: "Personal", deletingAt: null },
    },
    {
      spaceId: targetSpaceId,
      userId: run.userId,
      organizationId: "org-1",
      space: { id: targetSpaceId, name: targetSpaceName, deletingAt },
    },
  ];
}

function deps(
  options: {
    bots?: unknown[];
    hopBlocks?: unknown[];
    senderRunning?: boolean;
    alreadyDelivered?: unknown;
    targetArchived?: boolean;
    targetRenamed?: boolean;
    targetSpaceId?: string;
    spaceMembers?: unknown[];
    revokeTargetMembership?: boolean;
    targetSpaceRenamed?: boolean;
    inboundMessageId?: string;
    inboundMessage?: unknown;
    outboundMessageId?: string;
    outboundMessage?: unknown;
    groupMembership?: unknown;
    /** Simulate a unique (threadId, clientNonce) race after both retries miss. */
    uniqueConflictOnCommit?: boolean;
    transactionConflictOnce?: boolean;
  } = {},
) {
  const enqueue = vi.fn().mockResolvedValue(undefined);
  const notify = vi.fn().mockResolvedValue(undefined);
  const groupMemberFindFirst = vi.fn().mockResolvedValue(options.groupMembership ?? null);
  const messageFindUnique = vi
    .fn()
    .mockImplementation(
      async (args: { where?: { threadId_clientNonce?: unknown; id?: string } }) => {
        if (args?.where?.threadId_clientNonce) return options.alreadyDelivered ?? null;
        if (args?.where?.id === options.inboundMessageId) return options.inboundMessage ?? null;
        if (args?.where?.id === options.outboundMessageId) return options.outboundMessage ?? null;
        return { blocks: options.hopBlocks ?? [] };
      },
    );
  const memberships = (options.spaceMembers ?? []) as Array<{
    spaceId: string;
    userId: string;
  }>;
  const findMembership = vi.fn(
    async (
      { where }: { where: { spaceId_userId: { spaceId: string; userId: string } } },
      inTransaction = false,
    ) => {
      const key = where.spaceId_userId;
      if (
        inTransaction &&
        options.revokeTargetMembership &&
        key.spaceId === options.targetSpaceId
      ) {
        return null;
      }
      const membership =
        memberships.find(
          (candidate) => candidate.spaceId === key.spaceId && candidate.userId === key.userId,
        ) ?? null;
      if (
        inTransaction &&
        options.targetSpaceRenamed &&
        membership &&
        key.spaceId === options.targetSpaceId
      ) {
        const spaceMembership = membership as unknown as {
          space: { id: string; name: string; deletingAt: Date | null };
        };
        return {
          ...spaceMembership,
          space: { ...spaceMembership.space, name: "Renamed Research" },
        };
      }
      return membership;
    },
  );
  const findTargetBot = vi.fn(async ({ where }: { where?: { id?: string } }) => {
    if (options.targetArchived) return null;
    const bot = (
      options.bots ?? [
        { id: "bot-target", name: "Analyst", title: "", thread: { id: "thread-target" } },
      ]
    ).find((candidate) => (candidate as { id: string }).id === where?.id) as
      | {
          id: string;
          name: string;
          thread?: { id: string; spaceId?: string; botId?: string } | null;
        }
      | undefined;
    if (!bot) return null;
    return {
      id: bot.id,
      name: options.targetRenamed ? "Renamed Analyst" : bot.name,
      thread: bot.thread
        ? {
            id: bot.thread.id,
            spaceId: bot.thread.spaceId ?? options.targetSpaceId ?? run.spaceId,
            botId: bot.thread.botId ?? bot.id,
          }
        : null,
    };
  });
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([{ id: "thread" }]),
    run: {
      findFirst: vi
        .fn()
        .mockResolvedValue(options.senderRunning === false ? null : { id: "run-1" }),
      findUnique: vi.fn().mockResolvedValue({ status: "running" }),
      create: vi.fn().mockResolvedValue({ id: "run-2" }),
    },
    bot: {
      findFirst: findTargetBot,
    },
    spaceMember: { findUnique: vi.fn((args: unknown) => findMembership(args as never, true)) },
    chatGroupMember: { findFirst: groupMemberFindFirst },
    task: { create: vi.fn().mockResolvedValue({ id: "task-1" }) },
    message: {
      findUnique: messageFindUnique,
      create: vi.fn().mockResolvedValue({ id: "message-1", seq: 1 }),
      update: vi.fn().mockResolvedValue({}),
    },
    event: { create: vi.fn().mockResolvedValue({ seq: 7 }) },
    thread: { update: vi.fn().mockResolvedValue({}) },
  };
  let transactionAttempts = 0;
  const prisma = {
    bot: {
      findMany: vi.fn(async ({ where }: { where?: { spaceId?: string } }) =>
        (
          options.bots ?? [
            { id: "bot-target", name: "Analyst", title: "", thread: { id: "thread-target" } },
          ]
        ).map((candidate) => {
          const bot = candidate as {
            id: string;
            thread?: { id: string; spaceId?: string; botId?: string } | null;
          };
          return {
            ...bot,
            thread: bot.thread
              ? {
                  id: bot.thread.id,
                  spaceId: bot.thread.spaceId ?? where?.spaceId ?? run.spaceId,
                  botId: bot.thread.botId ?? bot.id,
                }
              : null,
          };
        }),
      ),
      findFirst: findTargetBot,
    },
    spaceMember: {
      findUnique: vi.fn((args: unknown) => findMembership(args as never)),
      findMany: vi.fn().mockResolvedValue(options.spaceMembers ?? []),
    },
    chatGroupMember: { findFirst: groupMemberFindFirst },
    message: { findUnique: messageFindUnique, findMany: vi.fn().mockResolvedValue([]) },
    run: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    $transaction: vi.fn(async (fn: (client: unknown) => unknown) => {
      transactionAttempts += 1;
      if (options.transactionConflictOnce && transactionAttempts === 1) {
        throw Object.assign(new Error("write conflict"), { code: "P2034" });
      }
      if (options.uniqueConflictOnCommit) {
        throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
      }
      return fn(tx);
    }),
  } as unknown as PrismaClient;
  return {
    deps: { prisma, events: { notify }, jobs: { enqueue } } as unknown as Pick<
      ExecutorDeps,
      "prisma" | "events" | "jobs"
    >,
    tx,
    enqueue,
    notify,
    setAlreadyDelivered(value: unknown) {
      options.alreadyDelivered = value;
    },
  };
}

describe("messaging another bot", () => {
  it("binds a case-insensitive cross-Space name to its canonical reviewed identity", async () => {
    const harness = deps({ spaceMembers: crossSpaceMemberships(), targetSpaceId: "space-target" });
    const prepared = await prepareMessageBotTarget(harness.deps.prisma, run, {
      target_space: "Research",
      confirm_name: "analyst",
      message: "Review the result",
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) throw new Error(prepared.error);
    expect(parseMessageBotTargetEffectRequest(prepared.effectRequest)).toMatchObject({
      binding: { target: { botId: "bot-target", botName: "Analyst" } },
      args: { bot_id: "bot-target", confirm_name: "Analyst" },
    });
  });

  it("preserves case-insensitive local name-only lookup", async () => {
    const harness = deps();
    const sent = await messageBot(harness.deps, run, sender, {
      confirm_name: "analyst",
      message: "Review the result",
    });
    expect(sent).toMatchObject({ ok: true, botId: "bot-target" });
    expect(harness.enqueue).toHaveBeenCalledOnce();
  });

  it("prefers an exact local name when another bot differs only by case", async () => {
    const harness = deps({
      bots: [
        { id: "bot-lower", name: "analyst", title: "", thread: { id: "thread-lower" } },
        { id: "bot-target", name: "Analyst", title: "", thread: { id: "thread-target" } },
      ],
    });
    const sent = await messageBot(harness.deps, run, sender, {
      confirm_name: "Analyst",
      message: "Review the result",
    });
    expect(sent).toMatchObject({ ok: true, botId: "bot-target" });
  });

  it("delivers into the target's own chat without marking either thread unread", async () => {
    const harness = deps();
    const sent = await messageBot(harness.deps, run, sender, {
      bot_id: "bot-target",
      message: "  chart the q3 numbers  ",
    });

    expect(sent).toMatchObject({ ok: true, botId: "bot-target", name: "Analyst" });
    expect(harness.tx.task.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          botId: "bot-target",
          threadId: "thread-target",
          prompt: expect.stringMatching(/not the user typing[\s\S]*untrusted peer content/),
        }),
      }),
    );
    expect(harness.tx.run.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          botId: "bot-target",
          threadId: "thread-target",
          status: "queued",
          trigger: "bot_message",
        }),
      }),
    );
    expect(harness.notify).toHaveBeenCalledWith("thread-target", 7);
    expect(harness.notify).toHaveBeenCalledWith("thread-sender", 7);
    expect(harness.tx.message.create).toHaveBeenCalledTimes(2);
    const outbound = harness.tx.message.create.mock.calls[0]?.[0] as unknown as {
      data: { blocks: Array<Record<string, unknown>> };
    };
    const inbound = harness.tx.message.create.mock.calls[1]?.[0] as unknown as {
      data: { blocks: Array<Record<string, unknown>> };
    };
    expect(outbound.data.blocks[0]).not.toHaveProperty("toSpaceId");
    expect(inbound.data.blocks[0]).not.toHaveProperty("fromSpaceId");
    expect(
      harness.tx.thread.update.mock.calls.filter(
        ([call]) => (call as { data?: { unread?: boolean } }).data?.unread,
      ),
    ).toHaveLength(0);
    expect(harness.enqueue).toHaveBeenCalledTimes(1);
  });

  it("marks a forced failure return unread on both sides", async () => {
    const harness = deps({
      hopBlocks: [
        {
          kind: "bot_message_received",
          fromBotId: "bot-target",
          fromBotName: "Coordinator",
          text: "research this",
          hop: 1,
          intent: "request",
          returnToMessageId: "message-request",
        },
      ],
    });
    await returnBotMessageOutcome(
      harness.deps,
      { ...run, sourceMessageId: "message-source" },
      sender,
      "Could not complete the delegated request.",
      "status",
      { forceUnread: true },
    );

    const unreadWrites = harness.tx.thread.update.mock.calls.filter(
      ([call]) => (call as { data?: { unread?: boolean } }).data?.unread === true,
    );
    expect(unreadWrites).toHaveLength(2);
  });

  it("tells the sender to continue independent work", async () => {
    const harness = deps();
    const sent = await messageBot(harness.deps, run, sender, {
      bot_id: "bot-target",
      message: "ping",
    });
    expect(sent.ok && sent.note).toContain("async");
    expect(sent.ok && sent.note).toContain("Continue independent work");
  });

  it("refuses a bot messaging itself", async () => {
    const harness = deps({
      bots: [{ id: "bot-sender", name: "Researcher", title: "", thread: { id: "thread-sender" } }],
    });
    const sent = await messageBot(harness.deps, run, sender, {
      bot_id: "bot-sender",
      message: "hello",
    });
    expect(sent).toEqual({ ok: false, error: "a bot cannot message itself" });
    expect(harness.enqueue).not.toHaveBeenCalled();
  });

  it("refuses an unknown target without starting a run", async () => {
    const harness = deps();
    const sent = await messageBot(harness.deps, run, sender, {
      bot_id: "bot-missing",
      message: "hello",
    });
    expect(sent).toEqual({ ok: false, error: "no bot found with that id or name" });
    expect(harness.tx.run.create).not.toHaveBeenCalled();
  });

  it("refuses an empty message", async () => {
    const harness = deps();
    const sent = await messageBot(harness.deps, run, sender, {
      bot_id: "bot-target",
      message: "   ",
    });
    expect(sent).toEqual({ ok: false, error: "message is required" });
  });

  it("rejects an oversized message instead of silently truncating it", async () => {
    const harness = deps();
    const sent = await messageBot(harness.deps, run, sender, {
      bot_id: "bot-target",
      message: "x".repeat(8_001),
    });
    expect(sent).toEqual({ ok: false, error: "message exceeds the 8000 character limit" });
    expect(harness.tx.run.create).not.toHaveBeenCalled();
  });

  it("does not deliver once the sending run is no longer active", async () => {
    const harness = deps({ senderRunning: false });
    const sent = await messageBot(harness.deps, run, sender, {
      bot_id: "bot-target",
      message: "hello",
    });
    expect(sent).toMatchObject({ ok: false });
    expect(harness.enqueue).not.toHaveBeenCalled();
  });

  it("stops a chain that has volleyed too many times", async () => {
    const harness = deps({
      hopBlocks: [
        { kind: "bot_message_received", fromBotId: "b", fromBotName: "B", text: "hi", hop: 6 },
      ],
    });
    const sent = await messageBot(
      harness.deps,
      { ...run, sourceMessageId: "message-source" },
      sender,
      { bot_id: "bot-target", message: "again" },
    );
    expect(sent.ok).toBe(false);
    expect(harness.tx.run.create).not.toHaveBeenCalled();
  });

  it("allows a final result back through after the request hop limit", async () => {
    const harness = deps({
      hopBlocks: [
        {
          kind: "bot_message_received",
          fromBotId: "bot-target",
          fromBotName: "Analyst",
          text: "please finish",
          hop: 6,
          intent: "request",
          returnToMessageId: "message-request",
        },
      ],
    });
    const sent = await messageBot(
      harness.deps,
      { ...run, sourceMessageId: "message-source" },
      sender,
      { bot_id: "bot-target", message: "finished", intent: "result" },
      { allowTerminalSource: true },
    );
    expect(sent.ok).toBe(true);
    expect(harness.tx.$queryRaw).toHaveBeenCalledTimes(2);
    expect(harness.tx.message.create).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          replyToMessageId: "message-request",
          blocks: expect.arrayContaining([expect.objectContaining({ intent: "result" })]),
        }),
      }),
    );
  });

  it("does not inherit a request reply link when messaging another bot", async () => {
    const harness = deps({
      bots: [
        { id: "bot-target", name: "Analyst", title: "", thread: { id: "thread-target" } },
        { id: "bot-other", name: "Writer", title: "", thread: { id: "thread-other" } },
      ],
      hopBlocks: [
        {
          kind: "bot_message_received",
          fromBotId: "bot-target",
          fromBotName: "Analyst",
          text: "check Gmail",
          hop: 1,
          intent: "request",
          returnToMessageId: "message-request",
        },
      ],
    });

    await messageBot(harness.deps, { ...run, sourceMessageId: "message-source" }, sender, {
      bot_id: "bot-other",
      message: "unrelated update",
      intent: "fyi",
    });

    expect(harness.tx.message.create).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ replyToMessageId: undefined }),
      }),
    );
  });

  it("does not inherit a request reply link for an FYI to the requester", async () => {
    const harness = deps({
      hopBlocks: [
        {
          kind: "bot_message_received",
          fromBotId: "bot-target",
          fromBotName: "Analyst",
          text: "check Gmail",
          hop: 1,
          intent: "request",
          returnToMessageId: "message-request",
        },
      ],
    });

    await messageBot(harness.deps, { ...run, sourceMessageId: "message-source" }, sender, {
      bot_id: "bot-target",
      message: "unrelated update",
      intent: "fyi",
    });

    expect(harness.tx.message.create).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ replyToMessageId: undefined }),
      }),
    );
  });

  it("does not exempt a terminal reply to another terminal reply", async () => {
    const harness = deps({
      hopBlocks: [
        {
          kind: "bot_message_received",
          fromBotId: "bot-target",
          fromBotName: "Analyst",
          text: "finished",
          hop: 6,
          intent: "result",
        },
      ],
    });
    const sent = await messageBot(
      harness.deps,
      { ...run, sourceMessageId: "message-source" },
      sender,
      { bot_id: "bot-target", message: "acknowledged", intent: "result" },
      { allowTerminalSource: true },
    );
    expect(sent.ok).toBe(false);
    expect(harness.tx.run.create).not.toHaveBeenCalled();
  });

  it("does not let a result label bypass the hop limit toward an unrelated bot", async () => {
    const harness = deps({
      bots: [
        { id: "bot-target", name: "Analyst", title: "", thread: { id: "thread-target" } },
        { id: "bot-other", name: "Writer", title: "", thread: { id: "thread-other" } },
      ],
      hopBlocks: [
        {
          kind: "bot_message_received",
          fromBotId: "bot-target",
          fromBotName: "Coordinator",
          text: "please finish",
          hop: 6,
          intent: "request",
        },
      ],
    });
    const sent = await messageBot(
      harness.deps,
      { ...run, sourceMessageId: "message-source" },
      sender,
      { bot_id: "bot-other", message: "keep going", intent: "result" },
    );
    expect(sent.ok).toBe(false);
    expect(harness.tx.run.create).not.toHaveBeenCalled();
  });

  it("keeps model-supplied status updates subject to the hop limit", async () => {
    const harness = deps({
      hopBlocks: [
        {
          kind: "bot_message_received",
          fromBotId: "bot-target",
          fromBotName: "Coordinator",
          text: "please finish",
          hop: 6,
          intent: "request",
        },
      ],
    });
    const sent = await messageBot(
      harness.deps,
      { ...run, sourceMessageId: "message-source" },
      sender,
      { bot_id: "bot-target", message: "still working", intent: "status" },
    );
    expect(sent.ok).toBe(false);
  });

  it("keeps a person-started chain going", async () => {
    const harness = deps({
      hopBlocks: [
        { kind: "bot_message_received", fromBotId: "b", fromBotName: "B", text: "hi", hop: 1 },
      ],
    });
    const sent = await messageBot(
      harness.deps,
      { ...run, sourceMessageId: "message-source" },
      sender,
      { bot_id: "bot-target", message: "carry on" },
    );
    expect(sent.ok).toBe(true);
  });

  it.each([
    ["name", "Research"],
    ["id", "space-target"],
  ])("delivers to a destination selected by Space %s", async (_kind, targetSpace) => {
    const harness = deps({
      spaceMembers: crossSpaceMemberships(),
      targetSpaceId: "space-target",
    });
    const request = {
      target_space: targetSpace,
      bot_id: "bot-target",
      confirm_name: "Analyst",
      message: "Review this result",
    };

    const sent = await messageBot(harness.deps, run, sender, request);

    expect(sent).toMatchObject({ ok: true, botId: "bot-target", name: "Analyst" });
    expect(harness.tx.task.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          spaceId: "space-target",
          threadId: "thread-target",
        }),
      }),
    );
    expect(harness.tx.run.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          spaceId: "space-target",
          threadId: "thread-target",
        }),
      }),
    );
    const outbound = harness.tx.message.create.mock.calls[0]?.[0] as unknown as {
      data: { threadId: string; blocks: Array<Record<string, unknown>> };
    };
    const inbound = harness.tx.message.create.mock.calls[1]?.[0] as unknown as {
      data: { threadId: string; blocks: Array<Record<string, unknown>> };
    };
    expect(outbound.data.threadId).toBe("thread-sender");
    expect(outbound.data.blocks[0]).toMatchObject({
      kind: "bot_message_sent",
      toSpaceId: "space-target",
      toSpaceName: "Research",
      toThreadId: "thread-target",
    });
    expect(inbound.data.threadId).toBe("thread-target");
    expect(inbound.data.blocks[0]).toMatchObject({
      kind: "bot_message_received",
      fromSpaceId: "workspace-1",
      fromSpaceName: "Personal",
      fromThreadId: "thread-sender",
    });
    expect(
      harness.tx.event.create.mock.calls.map(
        ([event]) => (event as { data: { spaceId: string } }).data.spaceId,
      ),
    ).toEqual(["space-target", "workspace-1"]);
  });

  it("rejects unknown, inaccessible, ambiguous, and deleting Spaces without falling back", async () => {
    const cases = [
      { selector: "Missing", memberships: crossSpaceMemberships().slice(0, 1) },
      { selector: "research", memberships: crossSpaceMemberships() },
      {
        selector: "Research",
        memberships: [
          ...crossSpaceMemberships(),
          {
            spaceId: "space-other",
            userId: run.userId,
            organizationId: "org-1",
            space: { id: "space-other", name: "Research", deletingAt: null },
          },
        ],
      },
      {
        selector: "Research",
        memberships: crossSpaceMemberships("space-target", "Research", new Date()),
      },
    ];
    for (const { selector, memberships } of cases) {
      const harness = deps({ spaceMembers: memberships, targetSpaceId: "space-target" });
      const sent = await messageBot(harness.deps, run, sender, {
        target_space: selector,
        bot_id: "bot-target",
        message: "Do not fall back",
      });
      expect(sent).toMatchObject({ ok: false, error: expect.any(String) });
      expect(harness.tx.message.create).not.toHaveBeenCalled();
      expect(harness.tx.task.create).not.toHaveBeenCalled();
      expect(harness.tx.run.create).not.toHaveBeenCalled();
      expect(harness.tx.event.create).not.toHaveBeenCalled();
    }
  });

  it("revalidates destination membership, bot activity, and reviewed names inside the transaction", async () => {
    for (const options of [
      { revokeTargetMembership: true },
      { targetSpaceRenamed: true },
      { targetArchived: true },
      { targetRenamed: true },
    ]) {
      const harness = deps({
        ...options,
        spaceMembers: crossSpaceMemberships(),
        targetSpaceId: "space-target",
      });
      const sent = await messageBot(harness.deps, run, sender, {
        target_space: "Research",
        bot_id: "bot-target",
        confirm_name: "Analyst",
        message: "Review this result",
      });
      expect(sent).toMatchObject({ ok: false, error: expect.any(String) });
      expect(harness.tx.message.create).not.toHaveBeenCalled();
      expect(harness.tx.task.create).not.toHaveBeenCalled();
      expect(harness.tx.run.create).not.toHaveBeenCalled();
      expect(harness.tx.event.create).not.toHaveBeenCalled();
      expect(harness.enqueue).not.toHaveBeenCalled();
    }
  });

  it("does not duplicate an exact cross-Space retry", async () => {
    const harness = deps({
      spaceMembers: crossSpaceMemberships(),
      targetSpaceId: "space-target",
    });
    const request = {
      target_space: "space-target",
      bot_id: "bot-target",
      message: "Review this result",
      deliveryKey: "same-effect-key",
    };

    await messageBot(harness.deps, run, sender, request);
    harness.setAlreadyDelivered({ id: "inbound-existing" });
    const retry = await messageBot(harness.deps, run, sender, request);

    expect(retry).toMatchObject({ ok: true, replayed: true });
    expect(harness.tx.message.create).toHaveBeenCalledTimes(2);
    expect(harness.tx.task.create).toHaveBeenCalledOnce();
    expect(harness.tx.run.create).toHaveBeenCalledOnce();
    expect(harness.enqueue).toHaveBeenCalledOnce();
  });

  it("rejects mismatched bot id and exact name instead of trusting the id", async () => {
    const harness = deps();
    const sent = await messageBot(harness.deps, run, sender, {
      bot_id: "bot-target",
      confirm_name: "Not Analyst",
      message: "Do not deliver",
    });

    expect(sent).toMatchObject({ ok: false, error: expect.any(String) });
    expect(harness.tx.message.create).not.toHaveBeenCalled();
    expect(harness.tx.task.create).not.toHaveBeenCalled();
  });

  it("rejects ambiguous exact bot names rather than selecting the first match", async () => {
    const harness = deps({
      bots: [
        { id: "bot-a", name: "Analyst", title: "", thread: { id: "thread-a" } },
        { id: "bot-b", name: "Analyst", title: "", thread: { id: "thread-b" } },
      ],
    });
    const sent = await messageBot(harness.deps, run, sender, {
      confirm_name: "Analyst",
      message: "Do not guess",
    });

    expect(sent).toMatchObject({ ok: false, error: expect.any(String) });
    expect(harness.tx.message.create).not.toHaveBeenCalled();
  });
});

describe("hop lookup", () => {
  it("treats a run a person started as the start of a chain", async () => {
    const prisma = { message: { findUnique: vi.fn() } } as unknown as PrismaClient;
    expect(await currentBotMessageHop(prisma, null)).toBe(0);
    expect(prisma.message.findUnique).not.toHaveBeenCalled();
  });

  it("reads the hop back off the message that woke the bot", async () => {
    const prisma = {
      message: {
        findUnique: vi.fn().mockResolvedValue({
          blocks: [
            { kind: "text", text: "noise" },
            { kind: "bot_message_received", fromBotId: "b", fromBotName: "B", text: "x", hop: 3 },
          ],
        }),
      },
    } as unknown as PrismaClient;
    expect(await currentBotMessageHop(prisma, "message-1")).toBe(3);
  });

  it("requires the linked request to target the agent that sent the wake-up", async () => {
    const prisma = {
      message: {
        findUnique: vi.fn().mockResolvedValue({
          blocks: [
            {
              kind: "bot_message_received",
              fromBotId: "requester",
              fromBotName: "Requester",
              text: "work on this",
              intent: "result",
              returnToMessageId: "request-message",
            },
          ],
          replyTo: {
            id: "different-message",
            blocks: [
              {
                kind: "bot_message_sent",
                toBotId: "other-agent",
                toBotName: "Other agent",
                text: "work on this",
                intent: "request",
              },
            ],
          },
        }),
      },
    } as unknown as PrismaClient;

    await expect(loadBotMessageContext(prisma, "message-source")).resolves.toMatchObject({
      repliesToRequest: false,
    });
  });

  it.each([
    ["result", true],
    ["status", true],
    ["fyi", true],
    ["request", false],
    ["question", false],
    [undefined, false],
  ])("classifies a linked %s message as a returned answer: %s", async (intent, expected) => {
    const prisma = {
      message: {
        findUnique: vi.fn().mockResolvedValue({
          blocks: [
            {
              kind: "bot_message_received",
              fromBotId: "requester",
              fromBotName: "Requester",
              text: "work on this",
              intent,
              returnToMessageId: "return-echo",
            },
          ],
          replyTo: {
            id: "request-message",
            blocks: [
              {
                kind: "bot_message_sent",
                toBotId: "requester",
                toBotName: "Requester",
                text: "work on this",
                intent: "request",
              },
            ],
          },
        }),
      },
    } as unknown as PrismaClient;

    await expect(loadBotMessageContext(prisma, "message-source")).resolves.toMatchObject({
      repliesToRequest: expected,
    });
  });
});

describe("cross-Space automatic result returns", () => {
  const crossRun = {
    id: "run-recipient",
    spaceId: "space-target",
    threadId: "thread-recipient",
    botId: "bot-recipient",
    userId: "user-1",
    sourceMessageId: "inbound-recipient",
  };
  const inboundBlock = {
    kind: "bot_message_received",
    fromBotId: "bot-source",
    fromBotName: "Coordinator",
    text: "Research this question",
    hop: 1,
    intent: "request",
    returnToMessageId: "outbound-source",
    fromSpaceId: "space-source",
    fromSpaceName: "Personal",
    fromThreadId: "thread-source",
  };
  const outboundBlock = {
    kind: "bot_message_sent",
    toBotId: "bot-recipient",
    toBotName: "Analyst",
    text: "Research this question",
    intent: "request",
    toSpaceId: "space-target",
    toSpaceName: "Research",
    toThreadId: "thread-recipient",
  };

  function returnHarness(
    outbound = outboundBlock,
    sourceThreadId = "thread-source",
    directThreadId = sourceThreadId,
    groupMembership?: unknown,
  ) {
    const routedInboundBlock = { ...inboundBlock, fromThreadId: sourceThreadId };
    return deps({
      bots: [{ id: "bot-source", name: "Coordinator", title: "", thread: { id: directThreadId } }],
      targetSpaceId: "space-source",
      groupMembership,
      spaceMembers: [
        {
          spaceId: "space-target",
          userId: "user-1",
          organizationId: "org-1",
          space: { id: "space-target", name: "Research", deletingAt: null },
        },
        {
          spaceId: "space-source",
          userId: "user-1",
          organizationId: "org-1",
          space: { id: "space-source", name: "Personal", deletingAt: null },
        },
      ],
      inboundMessageId: "inbound-recipient",
      inboundMessage: {
        role: "user",
        runId: crossRun.id,
        blocks: [routedInboundBlock],
        thread: { id: crossRun.threadId, spaceId: crossRun.spaceId, botId: crossRun.botId },
      },
      outboundMessageId: "outbound-source",
      outboundMessage: {
        role: "bot",
        botId: "bot-source",
        blocks: [outbound],
        thread: {
          id: sourceThreadId,
          spaceId: "space-source",
          botId: sourceThreadId === directThreadId ? "bot-source" : null,
        },
      },
    });
  }

  it("returns the final result to the exact original source thread from verified provenance", async () => {
    const harness = returnHarness();
    const returned = await returnBotMessageOutcome(
      harness.deps,
      crossRun,
      { id: "bot-recipient", name: "Analyst" },
      "The answer is 42.",
      "result",
    );

    expect(returned).toBe(true);
    expect(harness.tx.task.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          spaceId: "space-source",
          botId: "bot-source",
          threadId: "thread-source",
        }),
      }),
    );
    expect(harness.tx.run.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          spaceId: "space-source",
          botId: "bot-source",
          threadId: "thread-source",
        }),
      }),
    );
    const outbound = harness.tx.message.create.mock.calls[0]?.[0] as unknown as {
      data: { threadId: string; blocks: Array<Record<string, unknown>> };
    };
    const inbound = harness.tx.message.create.mock.calls[1]?.[0] as unknown as {
      data: { threadId: string; blocks: Array<Record<string, unknown>> };
    };
    expect(outbound.data.threadId).toBe("thread-recipient");
    expect(outbound.data.blocks[0]).toMatchObject({
      kind: "bot_message_sent",
      toSpaceId: "space-source",
      toThreadId: "thread-source",
    });
    expect(inbound.data.threadId).toBe("thread-source");
    expect(inbound.data.blocks[0]).toMatchObject({
      kind: "bot_message_received",
      fromSpaceId: "space-target",
      fromSpaceName: "Research",
      fromThreadId: "thread-recipient",
      text: "The answer is 42.",
    });
    expect(harness.enqueue).toHaveBeenCalledOnce();
  });

  it("returns to the original group thread only while the source bot remains a member", async () => {
    const harness = returnHarness(outboundBlock, "group-source", "thread-source-direct", {
      id: "group-membership",
    });
    const returned = await returnBotMessageOutcome(
      harness.deps,
      crossRun,
      { id: "bot-recipient", name: "Analyst" },
      "The answer is 42.",
      "result",
    );

    expect(returned).toBe(true);
    expect(harness.tx.task.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ spaceId: "space-source", threadId: "group-source" }),
      }),
    );
    expect(harness.tx.chatGroupMember.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          botId: "bot-source",
          group: expect.objectContaining({ userId: "user-1", archivedAt: null }),
        }),
      }),
    );
  });

  it("does not return a result to a group after the source bot is removed", async () => {
    const harness = returnHarness(outboundBlock, "group-source", "thread-source-direct");
    const returned = await returnBotMessageOutcome(
      harness.deps,
      crossRun,
      { id: "bot-recipient", name: "Analyst" },
      "The answer is 42.",
      "result",
    );

    expect(returned).toBe(true);
    expect(harness.tx.message.create).not.toHaveBeenCalled();
    expect(harness.tx.task.create).not.toHaveBeenCalled();
    expect(harness.tx.run.create).not.toHaveBeenCalled();
    expect(harness.enqueue).not.toHaveBeenCalled();
  });

  it.each([
    ["thread", { ...outboundBlock, toThreadId: "other-thread" }],
    ["Space name", { ...outboundBlock, toSpaceName: "Renamed Research" }],
  ])(
    "refuses an automatic return when the persisted outbound %s does not match",
    async (_label, outbound) => {
      const harness = returnHarness(outbound);
      const returned = await returnBotMessageOutcome(
        harness.deps,
        crossRun,
        { id: "bot-recipient", name: "Analyst" },
        "The answer is 42.",
        "result",
      );

      expect(returned).toBe(true);
      expect(harness.tx.message.create).not.toHaveBeenCalled();
      expect(harness.tx.task.create).not.toHaveBeenCalled();
      expect(harness.tx.run.create).not.toHaveBeenCalled();
      expect(harness.enqueue).not.toHaveBeenCalled();
    },
  );
});

describe("hardening", () => {
  it("does not deliver twice when the tool call is re-executed", async () => {
    const harness = deps({ alreadyDelivered: { id: "message-1" } });
    const sent = await messageBot(harness.deps, run, sender, {
      bot_id: "bot-target",
      message: "chart it",
      deliveryKey: "call-1",
    });

    expect(sent).toMatchObject({ ok: true, replayed: true, botId: "bot-target" });
    expect(harness.tx.run.create).not.toHaveBeenCalled();
    expect(harness.enqueue).not.toHaveBeenCalled();
  });

  it("stamps the delivery so a retry can recognise it", async () => {
    const harness = deps();
    await messageBot(harness.deps, run, sender, {
      bot_id: "bot-target",
      message: "chart it",
      deliveryKey: "call-1",
    });
    expect(harness.tx.message.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ clientNonce: "bot-message:call-1" }),
      }),
    );
  });

  it("still delivers when the caller supplies no delivery key", async () => {
    const harness = deps();
    const sent = await messageBot(harness.deps, run, sender, {
      bot_id: "bot-target",
      message: "chart it",
    });
    expect(sent.ok).toBe(true);
    expect(harness.tx.run.create).toHaveBeenCalled();
  });

  it("does not deliver to a bot archived while the message was being sent", async () => {
    const harness = deps({ targetArchived: true });
    const sent = await messageBot(harness.deps, run, sender, {
      bot_id: "bot-target",
      message: "chart it",
    });
    expect(sent).toMatchObject({ ok: false });
    expect(harness.tx.run.create).not.toHaveBeenCalled();
    expect(harness.enqueue).not.toHaveBeenCalled();
  });

  it("treats a delivery-key unique conflict as a replay", async () => {
    const harness = deps({ uniqueConflictOnCommit: true });
    // After both retries miss and the loser hits P2002, the winner is visible.
    (harness.deps.prisma.message.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "message-winner",
    });

    const sent = await messageBot(harness.deps, run, sender, {
      bot_id: "bot-target",
      message: "chart it",
      deliveryKey: "call-1",
    });

    expect(sent).toMatchObject({ ok: true, replayed: true, botId: "bot-target" });
    expect(harness.enqueue).not.toHaveBeenCalled();
    expect(harness.notify).not.toHaveBeenCalled();
  });

  it("retries a serialization conflict without dropping the delivery", async () => {
    const harness = deps({ transactionConflictOnce: true });
    const sent = await messageBot(harness.deps, run, sender, {
      bot_id: "bot-target",
      message: "chart it",
    });
    expect(sent.ok).toBe(true);
    expect(harness.deps.prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(harness.enqueue).toHaveBeenCalledOnce();
  });
});

describe("automatic outcome return", () => {
  it("routes a delegated run's final text back to its coordinator", async () => {
    const harness = deps({
      hopBlocks: [
        {
          kind: "bot_message_received",
          fromBotId: "bot-target",
          fromBotName: "Coordinator",
          text: "research this",
          hop: 1,
          intent: "request",
          returnToMessageId: "message-request",
        },
      ],
    });
    const returned = await returnBotMessageOutcome(
      harness.deps,
      { ...run, sourceMessageId: "message-source" },
      sender,
      "The answer is 42.",
    );
    expect(returned).toBe(true);
    expect(harness.tx.run.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ trigger: "bot_message" }) }),
    );
    expect(harness.tx.run.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: { in: ["completed", "failed", "cancelled"] },
        }),
      }),
    );
    expect(harness.enqueue).toHaveBeenCalledOnce();
    expect(harness.deps.prisma.run.updateMany).toHaveBeenCalledWith({
      where: {
        id: run.id,
        status: { in: ["completed", "failed", "cancelled"] },
        botOutcomeReturnedAt: null,
      },
      data: { botOutcomeReturnedAt: expect.any(Date) },
    });
  });

  it("still returns a final result after an interim status update", async () => {
    const harness = deps({
      hopBlocks: [
        {
          kind: "bot_message_received",
          fromBotId: "bot-target",
          fromBotName: "Coordinator",
          text: "research this",
          hop: 1,
          intent: "request",
          returnToMessageId: "message-request",
        },
      ],
    });
    vi.mocked(harness.deps.prisma.message.findMany).mockResolvedValue([
      {
        blocks: [
          {
            kind: "bot_message_sent",
            toBotId: "bot-target",
            toBotName: "Coordinator",
            text: "still looking",
            hop: 2,
            intent: "status",
          },
        ],
      },
    ] as never);

    const returned = await returnBotMessageOutcome(
      harness.deps,
      { ...run, sourceMessageId: "message-source" },
      sender,
      "The answer is 42.",
    );

    expect(returned).toBe(true);
    expect(harness.enqueue).toHaveBeenCalledOnce();
  });

  it("skips the automatic return when a result was already sent", async () => {
    const harness = deps({
      hopBlocks: [
        {
          kind: "bot_message_received",
          fromBotId: "bot-target",
          fromBotName: "Coordinator",
          text: "research this",
          hop: 1,
          intent: "request",
          returnToMessageId: "message-request",
        },
      ],
    });
    vi.mocked(harness.deps.prisma.message.findMany).mockResolvedValue([
      {
        blocks: [
          {
            kind: "bot_message_sent",
            toBotId: "bot-target",
            toBotName: "Coordinator",
            text: "done",
            hop: 2,
            intent: "result",
          },
        ],
      },
    ] as never);

    const returned = await returnBotMessageOutcome(
      harness.deps,
      { ...run, sourceMessageId: "message-source" },
      sender,
      "The answer is 42.",
    );

    expect(returned).toBe(true);
    expect(harness.enqueue).not.toHaveBeenCalled();
    expect(harness.deps.prisma.run.updateMany).toHaveBeenCalled();
  });
});
