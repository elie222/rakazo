import { BOT_MESSAGE_MAX_HOPS } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { RunHistoryWriteError } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import type { ExecutorDeps } from "../runs/executor/executor-deps.js";
import {
  currentBotMessageHop,
  loadBotMessageContext,
  messageBot,
  reportBotMessageWait,
  returnBotMessageOutcome,
} from "./bot-messages.js";

const run = {
  id: "run-1",
  spaceId: "workspace-1",
  threadId: "thread-sender",
  botId: "bot-sender",
  userId: "user-1",
  sourceMessageId: null as string | null,
};
const sender = { id: "bot-sender", name: "Researcher" };

function deps(
  options: {
    bots?: unknown[];
    hopBlocks?: unknown[];
    senderRunning?: boolean;
    alreadyDelivered?: unknown;
    targetArchived?: boolean;
    requesterArchived?: boolean;
    /** Simulate a unique (threadId, clientNonce) race after both retries miss. */
    uniqueConflictOnCommit?: boolean;
    transactionConflictOnce?: boolean;
    deletingSpace?: boolean;
    /** Task prompt of the sending run; a "Work on ticket OPS-7..." prompt marks ticket origin. */
    taskPrompt?: string;
    board?: { id: string; ticketPrefix: string } | null;
    ticket?: { id: string; assigneeBotId: string | null } | null;
    /**
     * The ticket row the in-transaction assignee wake sees; defaults to `ticket` enriched.
     * A different assignee here simulates a reassignment committed after the send's
     * routing read but before the delivery transaction's locked read.
     */
    wakeTicket?: unknown;
    /**
     * A reassignment that commits after the send's routing read but before the
     * delivery transaction's locked read: from that locked read on, every later
     * reader — routing or in-transaction — sees the new assignee, like a row that
     * really changed in between. Unlike `wakeTicket`, the change persists.
     */
    reassignedDuringDelivery?: string | null;
    /** Labs stored on the assignee owner's user row; the board gate reads them. */
    ownerLabs?: string[];
    /** Deployment-wide lab flags, as the executor's runtime env supplies them. */
    deploymentLabs?: string[];
    /** The auto-outcome claim finds the run already returned. */
    outcomeAlreadyClaimed?: boolean;
  } = {},
) {
  const enqueue = vi.fn().mockResolvedValue(undefined);
  const notify = vi.fn().mockResolvedValue(undefined);
  const messageFindUnique = vi
    .fn()
    .mockImplementation(async (args: { where?: { threadId_clientNonce?: unknown } }) =>
      args?.where?.threadId_clientNonce
        ? (options.alreadyDelivered ?? null)
        : { blocks: options.hopBlocks ?? [] },
    );
  /** The assignee every reader sees; a simulated mid-delivery reassignment moves it. */
  let liveAssignee: string | null = options.ticket ? options.ticket.assigneeBotId : null;
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([{ id: "thread" }]),
    $executeRaw: vi.fn().mockResolvedValue(0),
    space: {
      findUnique: vi
        .fn()
        .mockResolvedValue({ deletingAt: options.deletingSpace ? new Date() : null }),
    },
    run: {
      findFirst: vi
        .fn()
        .mockResolvedValue(options.senderRunning === false ? null : { id: "run-1" }),
      findUnique: vi.fn().mockResolvedValue({ status: "running" }),
      create: vi.fn().mockResolvedValue({ id: "run-2" }),
      updateMany: vi.fn().mockResolvedValue({ count: options.outcomeAlreadyClaimed ? 0 : 1 }),
    },
    bot: {
      findFirst: vi.fn().mockImplementation(async (args: { where?: { id?: string } }) => {
        if (options.targetArchived && args?.where?.id === "bot-target") return null;
        return args?.where?.id
          ? { id: args.where.id, userId: "user-1", thread: { id: "thread-sender" } }
          : { id: "bot-target" };
      }),
    },
    user: { findUnique: vi.fn().mockResolvedValue({ labs: options.ownerLabs ?? ["board"] }) },
    task: { create: vi.fn().mockResolvedValue({ id: "task-1" }) },
    message: {
      findUnique: messageFindUnique,
      create: vi.fn().mockResolvedValue({ id: "message-1", seq: 1 }),
      update: vi.fn().mockResolvedValue({}),
    },
    event: { create: vi.fn().mockResolvedValue({ seq: 7 }) },
    thread: { update: vi.fn().mockResolvedValue({}) },
    ticketComment: { create: vi.fn().mockResolvedValue({ id: "comment-1" }) },
    ticket: {
      findFirst: vi.fn().mockImplementation(async () => {
        if (options.reassignedDuringDelivery !== undefined)
          liveAssignee = options.reassignedDuringDelivery;
        if (options.wakeTicket !== undefined) return options.wakeTicket;
        return options.ticket
          ? {
              id: options.ticket.id,
              assigneeBotId: liveAssignee,
              status: "doing",
              number: 7,
              board: { ticketPrefix: "OPS" },
            }
          : null;
      }),
      update: vi.fn().mockResolvedValue({}),
    },
  };
  /** Each time a chat was marked unread for its Space's members. */
  const unreadMarks = () =>
    tx.$executeRaw.mock.calls.filter(([sql]) =>
      (sql as TemplateStringsArray).join("?").includes("INSERT INTO thread_reads"),
    );
  let transactionAttempts = 0;
  const prisma = {
    bot: {
      findFirst: vi.fn().mockImplementation(async (args: { where?: { id?: string } }) => {
        if (options.requesterArchived) return null;
        // The ticket chains ask their requester (the sender bot) for a reply back.
        if (args?.where?.id === "bot-sender") return { id: "bot-sender", name: "Researcher" };
        return { id: "bot-target", name: "Analyst" };
      }),
      findMany: vi
        .fn()
        .mockResolvedValue(
          options.bots ?? [
            { id: "bot-target", name: "Analyst", title: "", thread: { id: "thread-target" } },
          ],
        ),
    },
    message: { findUnique: messageFindUnique, findMany: vi.fn().mockResolvedValue([]) },
    run: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    task: {
      findUnique: vi
        .fn()
        .mockResolvedValue(options.taskPrompt ? { prompt: options.taskPrompt } : null),
    },
    board: {
      findUnique: vi.fn().mockResolvedValue(options.board === undefined ? null : options.board),
    },
    ticket: {
      findFirst: vi
        .fn()
        .mockImplementation(async () =>
          options.ticket ? { id: options.ticket.id, assigneeBotId: liveAssignee } : null,
        ),
    },
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
  const onTicketChange = vi.fn().mockResolvedValue(undefined);
  return {
    deps: {
      prisma,
      events: { notify },
      jobs: { enqueue },
      onTicketChange,
      ...(options.deploymentLabs ? { deploymentLabs: options.deploymentLabs } : {}),
    } as unknown as Pick<
      ExecutorDeps,
      "prisma" | "events" | "jobs" | "runLease" | "onTicketChange" | "deploymentLabs"
    >,
    tx,
    unreadMarks,
    enqueue,
    onTicketChange,
    notify,
  };
}

describe("messaging another bot", () => {
  it("starts no run for the target while the Space is being deleted", async () => {
    const harness = deps({ deletingSpace: true });
    const sent = await messageBot(harness.deps, run, sender, {
      bot_id: "bot-target",
      message: "chart the q3 numbers",
    });

    expect(sent).toMatchObject({ ok: false });
    expect(harness.tx.run.create).not.toHaveBeenCalled();
    expect(harness.enqueue).not.toHaveBeenCalled();
  });

  it("does not deliver when multiple bots have the same exact name", async () => {
    const harness = deps({
      bots: [
        { id: "bot-first", name: "Reviewer", thread: { id: "thread-first" } },
        { id: "bot-second", name: "Reviewer", thread: { id: "thread-second" } },
      ],
    });
    const sent = await messageBot(harness.deps, run, sender, {
      confirm_name: "Reviewer",
      message: "review this",
    });

    expect(sent).toMatchObject({ ok: false });
    expect(harness.tx.message.create).not.toHaveBeenCalled();
    expect(harness.tx.task.create).not.toHaveBeenCalled();
    expect(harness.tx.run.create).not.toHaveBeenCalled();
    expect(harness.enqueue).not.toHaveBeenCalled();
    expect(harness.notify).not.toHaveBeenCalled();
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
    expect(harness.unreadMarks()).toHaveLength(0);
    expect(harness.enqueue).toHaveBeenCalledTimes(1);
  });

  it("puts sent files on the recipient's message, and only the text in the sender's echo", async () => {
    const harness = deps();
    const file = {
      kind: "file" as const,
      artifactId: "artifact-zip",
      name: "project.zip",
      mimeType: "application/zip",
      size: 19_000,
    };
    const sent = await messageBot(harness.deps, run, sender, {
      bot_id: "bot-target",
      message: "deploy this",
      files: [file],
    });

    expect(sent).toMatchObject({ ok: true });
    const created = harness.tx.message.create.mock.calls.map(
      ([call]) => (call as { data: { threadId: string; blocks: Array<{ kind: string }> } }).data,
    );
    expect(created.find((m) => m.threadId === "thread-sender")?.blocks).toEqual([
      expect.objectContaining({ kind: "bot_message_sent" }),
    ]);
    expect(created.find((m) => m.threadId === "thread-target")?.blocks).toEqual([
      expect.objectContaining({ kind: "bot_message_received" }),
      file,
    ]);
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

    expect(harness.unreadMarks()).toHaveLength(2);
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
    expect(sent).toEqual({
      ok: false,
      error:
        "no bot found with that id or name. Bots reachable from this space (use bot_id): Analyst (bot-target)",
    });
    expect(harness.tx.run.create).not.toHaveBeenCalled();
  });

  it("names the bots a failed lookup could have used, never the sender or one without a chat", async () => {
    const harness = deps({
      bots: [
        { id: "bot-sender", name: "Researcher", thread: { id: "thread-sender" } },
        { id: "bot-target", name: "Analyst", thread: { id: "thread-target" } },
        { id: "bot-quiet", name: "Drafthelper", thread: null },
      ],
    });
    const sent = await messageBot(harness.deps, run, sender, {
      confirm_name: "analys",
      message: "hello",
    });

    expect(sent).toEqual({
      ok: false,
      error:
        "no bot found with that id or name. Bots reachable from this space (use bot_id): Analyst (bot-target)",
    });
  });

  it("says when no other bot can be messaged, instead of listing nothing", async () => {
    const harness = deps({
      bots: [{ id: "bot-sender", name: "Researcher", thread: { id: "thread-sender" } }],
    });
    const sent = await messageBot(harness.deps, run, sender, {
      bot_id: "bot-missing",
      message: "hi",
    });

    expect(sent).toEqual({
      ok: false,
      error: "no bot found with that id or name. No other bot in this space has a chat to message",
    });
  });

  it("bounds the list so a large Space cannot flood one tool result", async () => {
    const harness = deps({
      bots: Array.from({ length: 20 }, (_, index) => ({
        id: `bot-${index}`,
        name: `Bot number ${index}`,
        thread: { id: `thread-${index}` },
      })),
    });
    const sent = await messageBot(harness.deps, run, sender, {
      bot_id: "bot-missing",
      message: "hi",
    });

    expect(sent.ok).toBe(false);
    const error = sent.ok ? "" : sent.error;
    expect(error).toContain("Bot number 0 (bot-0)");
    expect(error).toContain("Bot number 11 (bot-11)");
    expect(error).not.toContain("Bot number 12 (bot-12)");
    expect(error).toContain("and 8 more");
  });

  it("keeps a bot name on one clean line in the error", async () => {
    const harness = deps({
      bots: [{ id: "bot-weird", name: "Line\nbreak", thread: { id: "thread-weird" } }],
    });
    const sent = await messageBot(harness.deps, run, sender, {
      bot_id: "bot-missing",
      message: "hi",
    });

    expect(sent).toEqual({
      ok: false,
      error:
        "no bot found with that id or name. Bots reachable from this space (use bot_id): Line break (bot-weird)",
    });
  });

  it("looks for the target only among active bots of the run's own Space", async () => {
    const harness = deps();
    await messageBot(harness.deps, run, sender, { bot_id: "bot-target", message: "hello" });
    expect(harness.deps.prisma.bot.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { spaceId: run.spaceId, archivedAt: null } }),
    );
    expect(harness.deps.prisma.bot.findMany).toHaveBeenCalledTimes(1);
  });

  it("refuses an empty message", async () => {
    const harness = deps();
    const sent = await messageBot(harness.deps, run, sender, {
      bot_id: "bot-target",
      message: "   ",
    });
    expect(sent).toEqual({ ok: false, error: "message is required" });
  });

  it("rejects an oversized message and points to files instead of splitting it", async () => {
    const harness = deps();
    const sent = await messageBot(harness.deps, run, sender, {
      bot_id: "bot-target",
      message: "x".repeat(8_001),
    });
    expect(sent).toEqual({
      ok: false,
      error:
        "message exceeds the 8000 character limit. Nothing was sent. Save long content to a file and send it with files instead of splitting it across messages.",
    });
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

  it("does not deliver from an attempt a newer claim superseded", async () => {
    const harness = deps();
    harness.tx.run.findUnique.mockResolvedValue({
      status: "running",
      leaseOwner: "worker-2",
      leaseFence: 2,
    });
    await expect(
      messageBot(
        { ...harness.deps, runLease: { runId: run.id, owner: "worker-1", fence: 1 } },
        run,
        sender,
        { bot_id: "bot-target", message: "hello" },
      ),
    ).rejects.toBeInstanceOf(RunHistoryWriteError);
    expect(harness.tx.message.create).not.toHaveBeenCalled();
    expect(harness.tx.run.create).not.toHaveBeenCalled();
    expect(harness.enqueue).not.toHaveBeenCalled();
  });

  it("stops a runaway chain at the safety ceiling", async () => {
    const harness = deps({
      hopBlocks: [
        {
          kind: "bot_message_received",
          fromBotId: "b",
          fromBotName: "B",
          text: "hi",
          hop: BOT_MESSAGE_MAX_HOPS,
        },
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
          hop: BOT_MESSAGE_MAX_HOPS,
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
      { returnFrom: "ended" },
    );
    expect(sent.ok).toBe(true);
    // The Space's lock, then both thread rows.
    expect(harness.tx.$queryRaw).toHaveBeenCalledTimes(3);
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
          hop: BOT_MESSAGE_MAX_HOPS,
          intent: "result",
        },
      ],
    });
    const sent = await messageBot(
      harness.deps,
      { ...run, sourceMessageId: "message-source" },
      sender,
      { bot_id: "bot-target", message: "acknowledged", intent: "result" },
      { returnFrom: "ended" },
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
          hop: BOT_MESSAGE_MAX_HOPS,
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
          hop: BOT_MESSAGE_MAX_HOPS,
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

  it("keeps a chain going past six bot-to-bot messages", async () => {
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
    expect(sent.ok).toBe(true);
    expect(harness.tx.run.create).toHaveBeenCalledOnce();
    expect(harness.tx.message.create).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          threadId: "thread-target",
          blocks: expect.arrayContaining([
            expect.objectContaining({ kind: "bot_message_received", hop: 7 }),
          ]),
        }),
      }),
    );
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

describe("hardening", () => {
  /**
   * A ticket-tagged explicit send whose ticket can be reassigned between
   * attempts, and whose delivery-key probe sees the messages earlier attempts
   * committed (the fake's message rows): reassignment flips the route between
   * the ticket path and the ordinary chat path, and the same effect key must
   * not deliver through both.
   */
  function reassignmentHarness(startAssignee: string) {
    const sourceBlocks = [
      {
        kind: "bot_message_received",
        fromBotId: "bot-sender",
        fromBotName: "Researcher",
        text: "What quota applies?",
        hop: 1,
        intent: "request",
        ticketRef: "OPS-7",
      },
    ];
    const harness = deps({
      hopBlocks: sourceBlocks,
      board: { id: "board-1", ticketPrefix: "OPS" },
      ticket: { id: "ticket-7", assigneeBotId: startAssignee },
      bots: [
        { id: "bot-sender", name: "Researcher", title: "", thread: { id: "thread-sender" } },
        { id: "bot-other", name: "Planner", title: "", thread: { id: "thread-other" } },
      ],
    });
    let assignee = startAssignee;
    (
      harness.deps.prisma.ticket as unknown as { findFirst: ReturnType<typeof vi.fn> }
    ).findFirst.mockImplementation(async () => ({ id: "ticket-7", assigneeBotId: assignee }));
    // The locked in-transaction read sees the same row the routing read does:
    // once a reassignment commits, both return the new assignee.
    harness.tx.ticket.findFirst.mockImplementation(async () => ({
      id: "ticket-7",
      assigneeBotId: assignee,
      status: "doing",
      number: 7,
      board: { ticketPrefix: "OPS" },
    }));
    harness.tx.message.findUnique.mockImplementation(
      async (args: {
        where?: { threadId_clientNonce?: { threadId: string; clientNonce: string } };
      }) => {
        const probe = args?.where?.threadId_clientNonce;
        if (probe) {
          const committed = harness.tx.message.create.mock.calls
            .map(([call]) => call.data as { threadId: string; clientNonce?: string })
            .find(
              (data) => data.threadId === probe.threadId && data.clientNonce === probe.clientNonce,
            );
          return committed ? { id: "message-delivered" } : null;
        }
        return { blocks: sourceBlocks };
      },
    );
    return {
      ...harness,
      reassign: (next: string) => {
        assignee = next;
      },
    };
  }

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

  it("does not deliver twice when a reassignment moves the reply off the ticket", async () => {
    // First attempt: the target owns the ticket, so the explicit result goes to
    // the ticket path. A reassignment then flips the route; the retry with the
    // same effect key must replay instead of delivering to the chat as well.
    const harness = reassignmentHarness("bot-sender");
    const senderRun = {
      ...run,
      threadId: "thread-helper",
      botId: "bot-helper",
      sourceMessageId: "message-source",
    };
    const send = () =>
      messageBot(
        harness.deps,
        senderRun,
        { id: "bot-helper", name: "Surveyor" },
        {
          bot_id: "bot-sender",
          message: "Quota is five.",
          intent: "result",
          deliveryKey: "call-1",
        },
      );
    const first = await send();
    expect(first).toMatchObject({ ok: true });
    expect(harness.tx.ticketComment.create).toHaveBeenCalledTimes(1);
    harness.reassign("bot-other");
    const retried = await send();
    expect(retried).toMatchObject({ ok: true, replayed: true });
    // One comment, one assignee wake from the first attempt; the ordinary
    // path's second inbound, task and run never start.
    expect(harness.tx.ticketComment.create).toHaveBeenCalledTimes(1);
    expect(harness.tx.task.create).toHaveBeenCalledTimes(1);
    expect(harness.tx.run.create).toHaveBeenCalledTimes(1);
  });

  it("does not deliver twice when a reassignment moves the reply onto the ticket", async () => {
    // First attempt: the target does not own the ticket, so the send takes the
    // ordinary path. A reassignment then makes it the assignee; the retry with
    // the same effect key must replay instead of commenting on the ticket too.
    const harness = reassignmentHarness("bot-other");
    const senderRun = {
      ...run,
      threadId: "thread-helper",
      botId: "bot-helper",
      sourceMessageId: "message-source",
    };
    const send = () =>
      messageBot(
        harness.deps,
        senderRun,
        { id: "bot-helper", name: "Surveyor" },
        {
          bot_id: "bot-sender",
          message: "Quota is five.",
          intent: "result",
          deliveryKey: "call-1",
        },
      );
    const first = await send();
    expect(first).toMatchObject({ ok: true });
    expect(harness.tx.ticketComment.create).toHaveBeenCalledTimes(1);
    harness.reassign("bot-sender");
    const retried = await send();
    expect(retried).toMatchObject({ ok: true, replayed: true });
    // One comment and one recipient task/run from the first attempt; the
    // ticket path adds no second comment or assignee wake.
    expect(harness.tx.ticketComment.create).toHaveBeenCalledTimes(1);
    expect(harness.tx.task.create).toHaveBeenCalledTimes(1);
    expect(harness.tx.run.create).toHaveBeenCalledTimes(1);
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
    // The retried delivery keeps the thread-lock budget.
    expect(harness.deps.prisma.$transaction).toHaveBeenLastCalledWith(expect.any(Function), {
      timeout: 20_000,
    });
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

  it("counts the outcome as returned once the requesting bot is archived", async () => {
    const harness = deps({
      requesterArchived: true,
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
    expect(harness.deps.prisma.bot.findFirst).toHaveBeenCalledWith({
      where: { id: "bot-target", spaceId: run.spaceId, archivedAt: null },
      select: { id: true, name: true },
    });
    expect(harness.enqueue).not.toHaveBeenCalled();
    expect(harness.deps.prisma.run.updateMany).toHaveBeenCalledWith({
      where: {
        id: run.id,
        status: { in: ["completed", "failed", "cancelled"] },
        botOutcomeReturnedAt: null,
      },
      data: { botOutcomeReturnedAt: expect.any(Date) },
    });
  });
});

describe("waiting on the user", () => {
  const delegated = {
    ...run,
    sourceMessageId: "message-source",
    trigger: "bot_message",
  };
  const request = {
    kind: "bot_message_received",
    fromBotId: "bot-target",
    fromBotName: "Coordinator",
    text: "research this",
    hop: BOT_MESSAGE_MAX_HOPS,
    intent: "request",
    returnToMessageId: "message-request",
  };

  it("tells the requesting bot right away, even at the hop limit", async () => {
    const harness = deps({ hopBlocks: [request] });

    await reportBotMessageWait(harness.deps, delegated, sender, "Which city?", "attempt-1");

    expect(harness.tx.run.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: "waiting_input" }),
      }),
    );
    expect(harness.tx.message.create).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          threadId: "thread-target",
          clientNonce: "bot-message:waiting:attempt-1",
          blocks: expect.arrayContaining([
            expect.objectContaining({
              intent: "status",
              text: expect.stringContaining("Which city?"),
            }),
          ]),
        }),
      }),
    );
    expect(harness.enqueue).toHaveBeenCalledOnce();
  });

  it("says nothing when no bot is waiting on the run", async () => {
    const harness = deps({ hopBlocks: [{ ...request, intent: "fyi" }] });

    await reportBotMessageWait(
      harness.deps,
      { ...delegated, trigger: "user" },
      sender,
      "Which city?",
      "attempt-1",
    );
    await reportBotMessageWait(harness.deps, delegated, sender, "Which city?", "attempt-2");

    expect(harness.tx.run.create).not.toHaveBeenCalled();
  });
});

describe("ticket-originated bot messages", () => {
  const board = { id: "board-1", ticketPrefix: "OPS" };
  const ticket = { id: "ticket-7", assigneeBotId: "bot-sender" };
  const ticketRun = { ...run, trigger: "tickets" as const, taskId: "task-wake" };
  const clarification = [
    {
      kind: "bot_message_received",
      fromBotId: "bot-sender",
      fromBotName: "Researcher",
      text: "What quota applies?",
      hop: 1,
      intent: "request",
      ticketRef: "OPS-7",
    },
  ];

  it("delivers a ticket run's clarification with the ticket, and records the question there", async () => {
    const harness = deps({
      taskPrompt: "Work on ticket OPS-7. Read it with ticket_get.",
      board,
      ticket,
    });
    const sent = await messageBot(harness.deps, ticketRun, sender, {
      bot_id: "bot-target",
      message: "What quota applies?",
    });

    expect(sent).toMatchObject({ ok: true, botId: "bot-target" });
    if (!sent.ok) return;
    expect(sent.note).toContain("ticket OPS-7");
    const inbound = harness.tx.message.create.mock.calls
      .map(([call]) => call.data)
      .find((data) => data.threadId === "thread-target");
    expect(inbound?.blocks?.[0]).toMatchObject({
      kind: "bot_message_received",
      ticketRef: "OPS-7",
    });
    const wake = harness.tx.task.create.mock.calls.at(-1)?.[0];
    expect(wake?.data?.prompt).toContain("OPS-7");
    expect(wake?.data?.prompt).toContain("comment on ticket OPS-7");
    expect(harness.tx.ticketComment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          ticketId: "ticket-7",
          authorBotId: "bot-sender",
          body: "What quota applies?",
        }),
      }),
    );
    // The recipient still wakes as an ordinary bot_message run.
    expect(harness.tx.run.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ trigger: "bot_message" }) }),
    );
  });

  it("returns the outcome to the ticket, not the requester's chat", async () => {
    const harness = deps({ hopBlocks: clarification, board, ticket });
    const returned = await returnBotMessageOutcome(
      harness.deps,
      {
        ...run,
        id: "run-2",
        threadId: "thread-target",
        botId: "bot-target",
        sourceMessageId: "message-source",
      },
      { id: "bot-target", name: "Analyst" },
      "Quota is five.",
    );

    expect(returned).toBe(true);
    expect(harness.tx.ticketComment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          ticketId: "ticket-7",
          authorBotId: "bot-target",
          body: "Quota is five.",
        }),
      }),
    );
    // The auto outcome claims its exactly-once flag in the same transaction.
    expect(harness.tx.run.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "run-2", botOutcomeReturnedAt: null }),
        data: expect.objectContaining({ botOutcomeReturnedAt: expect.any(Date) }),
      }),
    );
    expect(harness.onTicketChange).toHaveBeenCalledWith(
      expect.objectContaining({ ticketId: "ticket-7", wakeAssignee: false }),
    );
    // Nothing reaches the requester's chat: no inbound message, no bot_message run, no
    // unread mark. The assignee's continuation is the ticket-triggered wake run the
    // delivery commits, nudged through the same durable run-row path as any other run.
    const senderThreadCreates = harness.tx.message.create.mock.calls
      .map(([call]) => call.data)
      .filter((data) => data.threadId === "thread-sender");
    expect(senderThreadCreates).toHaveLength(0);
    expect(harness.tx.run.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ trigger: "tickets", botId: "bot-sender" }),
      }),
    );
    const createdRuns = harness.tx.run.create.mock.calls.map(([call]) => call.data);
    expect(createdRuns).toHaveLength(1);
    expect(harness.enqueue).toHaveBeenCalledTimes(1);
    expect(harness.unreadMarks()).toHaveLength(0);
  });

  it("replays instead of double-commenting when the outcome was already returned", async () => {
    const harness = deps({
      hopBlocks: clarification,
      board,
      ticket,
      outcomeAlreadyClaimed: true,
    });
    const returned = await returnBotMessageOutcome(
      harness.deps,
      {
        ...run,
        id: "run-2",
        threadId: "thread-target",
        botId: "bot-target",
        sourceMessageId: "message-source",
      },
      { id: "bot-target", name: "Analyst" },
      "Quota is five.",
    );

    expect(returned).toBe(true);
    expect(harness.tx.ticketComment.create).not.toHaveBeenCalled();
    expect(harness.tx.message.create).not.toHaveBeenCalled();
  });

  it("records an explicit result send from the chain on the ticket and replays safely", async () => {
    const harness = deps({
      hopBlocks: clarification,
      board,
      ticket,
      bots: [
        { id: "bot-target", name: "Analyst", title: "", thread: { id: "thread-target" } },
        { id: "bot-sender", name: "Researcher", title: "", thread: { id: "thread-sender" } },
      ],
    });
    const replyRun = {
      ...run,
      id: "run-2",
      threadId: "thread-target",
      botId: "bot-target",
      sourceMessageId: "message-source",
    };
    const sent = await messageBot(
      harness.deps,
      replyRun,
      { id: "bot-target", name: "Analyst" },
      {
        bot_id: "bot-sender",
        message: "Quota is five.",
        intent: "result",
        deliveryKey: "effect-1",
      },
    );

    expect(sent).toMatchObject({ ok: true });
    if (sent.ok) expect(sent.note).toContain("ticket OPS-7");
    expect(harness.tx.ticketComment.create).toHaveBeenCalledTimes(1);
    // No chat delivery for the requester: the only run created is the assignee's
    // ticket-triggered wake, committed with the comment.
    expect(harness.tx.run.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ trigger: "tickets", botId: "bot-sender" }),
      }),
    );
    expect(harness.tx.run.create.mock.calls.map(([call]) => call.data)).toHaveLength(1);
    // The explicit terminal result settles the outcome in the same transaction, so the
    // automatic return after completion cannot double-comment (it replays on the claim).
    expect(harness.tx.run.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "run-2", botOutcomeReturnedAt: null }),
        data: expect.objectContaining({ botOutcomeReturnedAt: expect.any(Date) }),
      }),
    );

    // Run completion returns the outcome: the claim makes it a replay, not a second comment.
    vi.mocked(harness.tx.run.updateMany).mockResolvedValue({ count: 0 });
    const returned = await returnBotMessageOutcome(
      harness.deps,
      { ...replyRun },
      { id: "bot-target", name: "Analyst" },
      "Quota is five.",
    );
    expect(returned).toBe(true);
    expect(harness.tx.ticketComment.create).toHaveBeenCalledTimes(1);

    // The nonce probe now finds the echo the first delivery committed.
    vi.mocked(harness.tx.message.findUnique).mockImplementation(
      async (args: { where?: { threadId_clientNonce?: unknown } }) =>
        args?.where?.threadId_clientNonce ? { id: "message-existing" } : { blocks: clarification },
    );
    const again = await messageBot(
      harness.deps,
      replyRun,
      { id: "bot-target", name: "Analyst" },
      {
        bot_id: "bot-sender",
        message: "Quota is five.",
        intent: "result",
        deliveryKey: "effect-1",
      },
    );
    expect(again).toMatchObject({ ok: true, replayed: true });
    expect(harness.tx.ticketComment.create).toHaveBeenCalledTimes(1);
  });

  it("keeps ordinary conversational exchanges out of the ticket path", async () => {
    const harness = deps();
    const sent = await messageBot(harness.deps, run, sender, {
      bot_id: "bot-target",
      message: "chart the q3 numbers",
    });

    expect(sent).toMatchObject({ ok: true });
    expect(harness.tx.ticketComment.create).not.toHaveBeenCalled();
    const inbound = harness.tx.message.create.mock.calls
      .map(([call]) => call.data)
      .find((data) => data.threadId === "thread-target");
    expect(inbound?.blocks?.[0]).not.toHaveProperty("ticketRef");
    const wake = harness.tx.task.create.mock.calls.at(-1)?.[0];
    expect(wake?.data?.prompt).not.toContain("ticket");
  });

  it("resolves recipients only within the Space for a ticket run", async () => {
    const harness = deps({
      taskPrompt: "Work on ticket OPS-7. Read it with ticket_get.",
      board,
      bots: [{ id: "bot-elsewhere", name: "Elsewhere", thread: { id: "thread-elsewhere" } }],
    });
    const sent = await messageBot(harness.deps, ticketRun, sender, {
      bot_id: "bot-target",
      message: "anyone there?",
    });

    expect(sent).toMatchObject({ ok: false });
    expect(harness.tx.ticketComment.create).not.toHaveBeenCalled();
  });

  it("drops the outcome gracefully when the ticket no longer exists", async () => {
    const harness = deps({ hopBlocks: clarification, board, ticket: null });
    const returned = await returnBotMessageOutcome(
      harness.deps,
      {
        ...run,
        id: "run-2",
        threadId: "thread-target",
        botId: "bot-target",
        sourceMessageId: "message-source",
      },
      { id: "bot-target", name: "Analyst" },
      "Quota is five.",
    );

    expect(returned).toBe(true);
    expect(harness.tx.ticketComment.create).not.toHaveBeenCalled();
    expect(harness.deps.prisma.run.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "run-2", botOutcomeReturnedAt: null }),
      }),
    );
  });

  it("answers a helper's question in its chat, not only on the ticket", async () => {
    // The assignee (sender) replies to a question another bot asked it mid-ticket.
    const harness = deps({
      taskPrompt: "Work on ticket OPS-7. Read it with ticket_get.",
      board,
      ticket,
      hopBlocks: [
        {
          kind: "bot_message_received",
          fromBotId: "bot-target",
          fromBotName: "Analyst",
          text: "Which environment should I target?",
          hop: 1,
          intent: "question",
          ticketRef: "OPS-7",
        },
      ],
    });
    const sent = await messageBot(harness.deps, ticketRun, sender, {
      bot_id: "bot-target",
      message: "Use staging; production is frozen.",
      intent: "result",
    });

    expect(sent).toMatchObject({ ok: true, botId: "bot-target" });
    // The asking bot actually receives the answer: an inbound in its chat and a wake run.
    const inbound = harness.tx.message.create.mock.calls
      .map(([call]) => call.data)
      .find((data) => data.threadId === "thread-target");
    expect(inbound?.blocks?.[0]).toMatchObject({
      kind: "bot_message_received",
      ticketRef: "OPS-7",
    });
    expect(harness.tx.run.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ trigger: "bot_message", botId: "bot-target" }),
      }),
    );
    expect(harness.enqueue).toHaveBeenCalledOnce();
    // The exchange is still recorded on the ticket, but the sender is the assignee, so
    // no ticket wake is created for it.
    expect(harness.tx.ticketComment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ body: "Use staging; production is frozen." }),
      }),
    );
    expect(harness.tx.run.create.mock.calls.some(([call]) => call.data.trigger === "tickets")).toBe(
      false,
    );
  });

  it("returns a helper-to-helper answer to the helper that asked", async () => {
    // The asking bot no longer owns the ticket: the answer goes to it as an ordinary
    // bot message, recorded on the ticket, instead of vanishing into a ticket comment.
    const harness = deps({
      hopBlocks: [
        {
          kind: "bot_message_received",
          fromBotId: "bot-target",
          fromBotName: "Analyst",
          text: "Which quota applies?",
          hop: 2,
          intent: "question",
          ticketRef: "OPS-7",
        },
      ],
      board,
      ticket,
    });
    const returned = await returnBotMessageOutcome(
      harness.deps,
      {
        ...run,
        id: "run-3",
        threadId: "thread-helper2",
        botId: "bot-helper2",
        sourceMessageId: "message-source",
      },
      { id: "bot-helper2", name: "Surveyor" },
      "Quota is five.",
    );

    expect(returned).toBe(true);
    const inbound = harness.tx.message.create.mock.calls
      .map(([call]) => call.data)
      .find((data) => data.threadId === "thread-target");
    expect(inbound?.blocks?.[0]).toMatchObject({
      kind: "bot_message_received",
      ticketRef: "OPS-7",
    });
    expect(harness.tx.ticketComment.create).toHaveBeenCalledTimes(1);
    expect(harness.enqueue).toHaveBeenCalledOnce();
    expect(harness.deps.prisma.run.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "run-3", botOutcomeReturnedAt: null }),
      }),
    );
  });

  /**
   * Makes the delivery-key probe see the messages earlier attempts committed, so a
   * repeat of the same send replays instead of delivering again (the fake's rows).
   */
  function probeSeesCommittedStamps(harness: ReturnType<typeof deps>, blocks: unknown[]) {
    harness.tx.message.findUnique.mockImplementation(
      async (args: {
        where?: { threadId_clientNonce?: { threadId: string; clientNonce: string } };
      }) => {
        const probe = args?.where?.threadId_clientNonce;
        if (probe) {
          const committed = harness.tx.message.create.mock.calls
            .map(([created]) => created.data as { threadId: string; clientNonce?: string })
            .find(
              (data) => data.threadId === probe.threadId && data.clientNonce === probe.clientNonce,
            );
          return committed ? { id: "message-delivered" } : null;
        }
        return { blocks };
      },
    );
  }

  it("re-routes a reassigned-away result to the requester it still addresses", async () => {
    // The ticket is reassigned between the send's routing read and the locked read
    // inside the delivery transaction. The addressed requester is still active, so it
    // must receive its answer as a ticket-tagged reply — not lose it to a comment and
    // a successor wake it never reads. The complete contract: the requester's chat run,
    // the exchange recorded on the ticket, and no ticket continuation for the successor.
    const harness = deps({
      hopBlocks: clarification,
      board,
      ticket,
      bots: [
        { id: "bot-target", name: "Analyst", title: "", thread: { id: "thread-target" } },
        { id: "bot-sender", name: "Researcher", title: "", thread: { id: "thread-sender" } },
      ],
      reassignedDuringDelivery: "bot-successor",
    });
    probeSeesCommittedStamps(harness, clarification);
    const senderRun = {
      ...run,
      id: "run-2",
      threadId: "thread-target",
      botId: "bot-target",
      sourceMessageId: "message-source",
    };
    const send = () =>
      messageBot(
        harness.deps,
        senderRun,
        { id: "bot-target", name: "Analyst" },
        {
          bot_id: "bot-sender",
          message: "Quota is five.",
          intent: "result",
          deliveryKey: "effect-1",
        },
      );
    const sent = await send();

    expect(sent).toMatchObject({
      ok: true,
      botId: "bot-sender",
      note: expect.stringContaining("recorded on ticket OPS-7"),
    });
    // The addressed requester received the answer: a ticket-tagged bot reply in its chat.
    const inbound = harness.tx.message.create.mock.calls
      .map(([call]) => call.data)
      .find((data) => data.threadId === "thread-sender");
    expect(inbound?.blocks?.[0]).toMatchObject({
      kind: "bot_message_received",
      fromBotId: "bot-target",
      ticketRef: "OPS-7",
    });
    expect(harness.tx.task.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ botId: "bot-sender" }) }),
    );
    expect(harness.tx.run.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ trigger: "bot_message", botId: "bot-sender" }),
      }),
    );
    // The exchange is still recorded on the ticket...
    expect(harness.tx.ticketComment.create).toHaveBeenCalledTimes(1);
    // ...but no ticket continuation woke the successor for a reply its requester got.
    expect(harness.tx.run.create.mock.calls.some(([call]) => call.data.trigger === "tickets")).toBe(
      false,
    );
    // A replay of the same send adds nothing through either route.
    const again = await send();
    expect(again).toMatchObject({ ok: true, replayed: true });
    expect(harness.tx.ticketComment.create).toHaveBeenCalledTimes(1);
    expect(harness.tx.run.create).toHaveBeenCalledTimes(1);
  });

  it("re-routes a result onto the ticket when its recipient becomes the assignee", async () => {
    // The mirror race: the routing read sees another bot's ticket, so the send starts
    // on the chat path; a reassignment to the addressed bot commits before the
    // delivery transaction. The reply must land as the ticket comment with its
    // continuation, not start a chat run the assignee does not need.
    const harness = deps({
      hopBlocks: clarification,
      board,
      ticket: { id: "ticket-7", assigneeBotId: "bot-other" },
      bots: [
        { id: "bot-target", name: "Analyst", title: "", thread: { id: "thread-target" } },
        { id: "bot-sender", name: "Researcher", title: "", thread: { id: "thread-sender" } },
      ],
      reassignedDuringDelivery: "bot-sender",
    });
    probeSeesCommittedStamps(harness, clarification);
    const senderRun = {
      ...run,
      id: "run-2",
      threadId: "thread-target",
      botId: "bot-target",
      sourceMessageId: "message-source",
    };
    const send = () =>
      messageBot(
        harness.deps,
        senderRun,
        { id: "bot-target", name: "Analyst" },
        {
          bot_id: "bot-sender",
          message: "Quota is five.",
          intent: "result",
          deliveryKey: "effect-1",
        },
      );
    const sent = await send();

    expect(sent).toMatchObject({
      ok: true,
      botId: "bot-sender",
      note: expect.stringContaining("Recorded as a comment on ticket OPS-7"),
    });
    expect(harness.tx.ticketComment.create).toHaveBeenCalledTimes(1);
    // The continuation is the assignee's ticket wake, and no chat run started.
    expect(harness.tx.run.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ trigger: "tickets", botId: "bot-sender" }),
      }),
    );
    expect(
      harness.tx.run.create.mock.calls.some(([call]) => call.data.trigger === "bot_message"),
    ).toBe(false);
    expect(
      harness.tx.message.create.mock.calls.some(([call]) => call.data.threadId === "thread-sender"),
    ).toBe(false);
    const again = await send();
    expect(again).toMatchObject({ ok: true, replayed: true });
    expect(harness.tx.ticketComment.create).toHaveBeenCalledTimes(1);
    expect(harness.tx.run.create).toHaveBeenCalledTimes(1);
  });

  it("refuses the send when the assignment keeps changing under it, committing nothing", async () => {
    // The routing read and the locked read never agree, so no route can settle.
    // The model is told to send again and nothing has been committed meanwhile.
    const harness = deps({
      hopBlocks: clarification,
      board,
      ticket,
      bots: [
        { id: "bot-target", name: "Analyst", title: "", thread: { id: "thread-target" } },
        { id: "bot-sender", name: "Researcher", title: "", thread: { id: "thread-sender" } },
      ],
      wakeTicket: {
        id: "ticket-7",
        assigneeBotId: "bot-successor",
        status: "doing",
        number: 7,
        board: { ticketPrefix: "OPS" },
      },
    });
    const sent = await messageBot(
      harness.deps,
      {
        ...run,
        id: "run-2",
        threadId: "thread-target",
        botId: "bot-target",
        sourceMessageId: "message-source",
      },
      { id: "bot-target", name: "Analyst" },
      {
        bot_id: "bot-sender",
        message: "Quota is five.",
        intent: "result",
        deliveryKey: "effect-1",
      },
    );

    expect(sent).toMatchObject({ ok: false });
    expect(harness.tx.ticketComment.create).not.toHaveBeenCalled();
    expect(harness.tx.message.create).not.toHaveBeenCalled();
    expect(harness.tx.task.create).not.toHaveBeenCalled();
    expect(harness.tx.run.create).not.toHaveBeenCalled();
    expect(harness.enqueue).not.toHaveBeenCalled();
  });

  it("keeps a prepared attachment send on the route that can deliver the files", async () => {
    // Copies are already saved when the ticket is reassigned to the recipient
    // mid-send: re-routing to the text-only ticket path would strand them, so the
    // delivery stays on the chat path, which carries the attachment blocks.
    const files = [
      {
        kind: "file" as const,
        artifactId: "artifact-zip",
        name: "result.zip",
        mimeType: "application/zip",
        size: 19_000,
      },
    ];
    const harness = deps({
      hopBlocks: clarification,
      board,
      ticket: { id: "ticket-7", assigneeBotId: "bot-other" },
      bots: [
        { id: "bot-target", name: "Analyst", title: "", thread: { id: "thread-target" } },
        { id: "bot-sender", name: "Researcher", title: "", thread: { id: "thread-sender" } },
      ],
      reassignedDuringDelivery: "bot-sender",
    });
    const sent = await messageBot(
      harness.deps,
      {
        ...run,
        id: "run-2",
        threadId: "thread-target",
        botId: "bot-target",
        sourceMessageId: "message-source",
      },
      { id: "bot-target", name: "Analyst" },
      {
        bot_id: "bot-sender",
        message: "The archive is attached.",
        intent: "result",
        deliveryKey: "effect-1",
        files,
      },
    );

    expect(sent).toMatchObject({ ok: true, botId: "bot-sender" });
    const inbound = harness.tx.message.create.mock.calls
      .map(([call]) => call.data)
      .find((data) => data.threadId === "thread-sender");
    expect(inbound?.blocks).toEqual([
      expect.objectContaining({ kind: "bot_message_received" }),
      ...files,
    ]);
    expect(harness.tx.ticketComment.create).toHaveBeenCalledTimes(1);
    expect(harness.tx.run.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ trigger: "bot_message", botId: "bot-sender" }),
      }),
    );
  });

  it("keeps the wake recoverable when the nudge or the notifier fails", async () => {
    const harness = deps({ hopBlocks: clarification, board, ticket });
    harness.enqueue.mockRejectedValueOnce(new Error("queue down"));
    harness.onTicketChange.mockRejectedValueOnce(new Error("notifier down"));
    const returned = await returnBotMessageOutcome(
      harness.deps,
      {
        ...run,
        id: "run-2",
        threadId: "thread-target",
        botId: "bot-target",
        sourceMessageId: "message-source",
      },
      { id: "bot-target", name: "Analyst" },
      "Quota is five.",
    );

    // The delivery succeeds and the wake run row is committed with the comment: a lost
    // nudge is recovered by the run-row path, and the board refresh is ignorable.
    expect(returned).toBe(true);
    expect(harness.tx.ticketComment.create).toHaveBeenCalledTimes(1);
    expect(harness.tx.run.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ trigger: "tickets", botId: "bot-sender" }),
      }),
    );
  });

  it("refuses to launch work for a ticket that no longer exists", async () => {
    const harness = deps({
      taskPrompt: "Work on ticket OPS-7. Read it with ticket_get.",
      board,
      ticket: null,
    });
    for (const input of [
      { message: "What quota applies?" },
      { message: "Quota is five.", intent: "result" as const },
    ]) {
      const sent = await messageBot(harness.deps, ticketRun, sender, {
        bot_id: "bot-target",
        ...input,
      });
      expect(sent).toMatchObject({ ok: false, missingTicket: true });
      if (sent.ok) continue;
      expect(sent.error).toContain("no longer available");
    }
    expect(harness.tx.message.create).not.toHaveBeenCalled();
    expect(harness.tx.task.create).not.toHaveBeenCalled();
    expect(harness.tx.run.create).not.toHaveBeenCalled();
    expect(harness.tx.ticketComment.create).not.toHaveBeenCalled();
    expect(harness.enqueue).not.toHaveBeenCalled();
  });

  it("keeps the outcome on the ticket when the requester is archived", async () => {
    const harness = deps({
      requesterArchived: true,
      hopBlocks: clarification,
      board,
      ticket,
    });
    const returned = await returnBotMessageOutcome(
      harness.deps,
      {
        ...run,
        id: "run-2",
        threadId: "thread-target",
        botId: "bot-target",
        sourceMessageId: "message-source",
      },
      { id: "bot-target", name: "Analyst" },
      "Quota is five.",
    );

    // No requester to address does not drop the outcome: the comment lands, the
    // assignee wakes, and only the sender-thread echo is skipped.
    expect(returned).toBe(true);
    expect(harness.tx.ticketComment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          ticketId: "ticket-7",
          authorBotId: "bot-target",
          body: "Quota is five.",
        }),
      }),
    );
    expect(harness.tx.run.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ trigger: "tickets", botId: "bot-sender" }),
      }),
    );
    expect(harness.tx.message.create).not.toHaveBeenCalled();
    expect(harness.enqueue).toHaveBeenCalledOnce();
    expect(harness.deps.prisma.run.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "run-2", botOutcomeReturnedAt: null }),
      }),
    );
  });

  it("refreshes the board for a chat-path exchange recorded on the ticket", async () => {
    // The asker is not the assignee, so the send takes the ordinary path — but
    // its ticket comment must still signal the board, like every other comment.
    const harness = deps({
      hopBlocks: [
        {
          kind: "bot_message_received",
          fromBotId: "bot-target",
          fromBotName: "Analyst",
          text: "Which quota applies?",
          hop: 1,
          intent: "question",
          ticketRef: "OPS-7",
        },
      ],
      board,
      ticket,
    });
    const sent = await messageBot(
      harness.deps,
      { ...run, id: "run-2", sourceMessageId: "message-source" },
      sender,
      {
        bot_id: "bot-target",
        message: "Use staging; production is frozen.",
        intent: "result",
      },
    );

    expect(sent).toMatchObject({ ok: true });
    expect(harness.onTicketChange).toHaveBeenCalledTimes(1);
    expect(harness.onTicketChange).toHaveBeenCalledWith({
      spaceId: "workspace-1",
      boardId: "board-1",
      ticketId: "ticket-7",
      assigneeBotId: null,
      wakeAssignee: false,
    });
  });

  it("does not return an answer twice when the requester takes the ticket after an explicit reply", async () => {
    // The helper answered the asking bot in its chat while that bot did not own
    // the ticket, so nothing claimed the outcome. A reassignment then makes the
    // asker the assignee: the automatic return must settle on the explicit
    // answer instead of posting a second ticket comment and wake.
    const harness = deps({ hopBlocks: clarification, board, ticket });
    (
      harness.deps.prisma.message as unknown as { findMany: ReturnType<typeof vi.fn> }
    ).findMany.mockResolvedValue([
      {
        id: "m-explicit",
        blocks: [
          {
            kind: "bot_message_sent",
            toBotId: "bot-sender",
            toBotName: "Researcher",
            text: "Quota is five.",
            intent: "result",
          },
        ],
      },
    ]);
    const returned = await returnBotMessageOutcome(
      harness.deps,
      {
        ...run,
        id: "run-3",
        threadId: "thread-helper",
        botId: "bot-helper",
        sourceMessageId: "message-source",
      },
      { id: "bot-helper", name: "Surveyor" },
      "Quota is five.",
    );

    expect(returned).toBe(true);
    expect(harness.deps.prisma.run.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "run-3", botOutcomeReturnedAt: null }),
      }),
    );
    expect(harness.tx.ticketComment.create).not.toHaveBeenCalled();
    expect(harness.tx.task.create).not.toHaveBeenCalled();
    expect(harness.tx.run.create).not.toHaveBeenCalled();
    expect(harness.enqueue).not.toHaveBeenCalled();
  });

  it("wakes an assignee whose board access comes from the deployment labs", async () => {
    // A deployment that enables boards globally: the owner has no personal lab entry,
    // so the wake must consult the deployment flags the executor supplies.
    const harness = deps({
      hopBlocks: clarification,
      board,
      ticket,
      ownerLabs: [],
      deploymentLabs: ["board"],
      bots: [
        { id: "bot-target", name: "Analyst", title: "", thread: { id: "thread-target" } },
        { id: "bot-sender", name: "Researcher", title: "", thread: { id: "thread-sender" } },
      ],
    });
    const sent = await messageBot(
      harness.deps,
      {
        ...run,
        id: "run-2",
        threadId: "thread-target",
        botId: "bot-target",
        sourceMessageId: "message-source",
      },
      { id: "bot-target", name: "Analyst" },
      {
        bot_id: "bot-sender",
        message: "Quota is five.",
        intent: "result",
        deliveryKey: "effect-1",
      },
    );

    expect(sent).toMatchObject({ ok: true });
    if (sent.ok) expect(sent.note).toContain("assignee is woken");
    expect(harness.tx.run.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ trigger: "tickets", botId: "bot-sender" }),
      }),
    );
  });

  it("does not claim a wake when no continuation run was committed", async () => {
    // The ticket completed while the answer was in flight: the comment still lands,
    // but the tool result must not report a wake that never happened.
    const harness = deps({
      hopBlocks: clarification,
      board,
      ticket,
      wakeTicket: {
        id: "ticket-7",
        assigneeBotId: "bot-sender",
        status: "done",
        number: 7,
        board: { ticketPrefix: "OPS" },
      },
      bots: [
        { id: "bot-target", name: "Analyst", title: "", thread: { id: "thread-target" } },
        { id: "bot-sender", name: "Researcher", title: "", thread: { id: "thread-sender" } },
      ],
    });
    const sent = await messageBot(
      harness.deps,
      {
        ...run,
        id: "run-2",
        threadId: "thread-target",
        botId: "bot-target",
        sourceMessageId: "message-source",
      },
      { id: "bot-target", name: "Analyst" },
      {
        bot_id: "bot-sender",
        message: "Quota is five.",
        intent: "result",
        deliveryKey: "effect-1",
      },
    );

    expect(sent).toMatchObject({ ok: true });
    if (sent.ok) {
      expect(sent.note).toContain("Recorded as a comment on ticket OPS-7");
      expect(sent.note).not.toContain("assignee is woken");
    }
    expect(harness.tx.ticketComment.create).toHaveBeenCalledTimes(1);
    expect(harness.tx.run.create).not.toHaveBeenCalled();
    expect(harness.enqueue).not.toHaveBeenCalled();
  });
});

describe("ticket outcome classification", () => {
  const board = { id: "board-1", ticketPrefix: "OPS" };
  const ticket = { id: "ticket-7", assigneeBotId: "bot-sender" };
  const helperRun = {
    ...run,
    id: "run-2",
    threadId: "thread-target",
    botId: "bot-target",
    sourceMessageId: "message-source",
  };
  const analyst = { id: "bot-target", name: "Analyst" };
  const sourceWith = (intent: string | undefined) => [
    {
      kind: "bot_message_received",
      fromBotId: "bot-sender",
      fromBotName: "Researcher",
      text: "Heads up",
      hop: 1,
      ...(intent ? { intent } : {}),
      ticketRef: "OPS-7",
    },
  ];

  it.each(["fyi", "status", "result"])(
    "routes no outcome for a %s source, so acknowledgements stay off the ticket",
    async (intent) => {
      const harness = deps({ hopBlocks: sourceWith(intent), board, ticket });
      const returned = await returnBotMessageOutcome(harness.deps, helperRun, analyst, "Noted.");

      // An FYI or update never solicited a reply: no ticket comment, no assignee
      // wake, no chat send — exactly the pre-ticket-messaging semantics.
      expect(returned).toBe(true);
      expect(harness.tx.ticketComment.create).not.toHaveBeenCalled();
      expect(harness.tx.run.create).not.toHaveBeenCalled();
      expect(harness.tx.task.create).not.toHaveBeenCalled();
      expect(harness.tx.message.create).not.toHaveBeenCalled();
      expect(harness.enqueue).not.toHaveBeenCalled();
      expect(harness.unreadMarks()).toHaveLength(0);
      // The run still settles exactly-once.
      expect(harness.deps.prisma.run.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: "run-2", botOutcomeReturnedAt: null }),
          data: expect.objectContaining({ botOutcomeReturnedAt: expect.any(Date) }),
        }),
      );
    },
  );

  it.each(["request", "question", undefined])(
    "keeps delivering a %s outcome to the ticket",
    async (intent) => {
      const harness = deps({ hopBlocks: sourceWith(intent), board, ticket });
      const returned = await returnBotMessageOutcome(harness.deps, helperRun, analyst, "Done.");

      expect(returned).toBe(true);
      expect(harness.tx.ticketComment.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ ticketId: "ticket-7", authorBotId: "bot-target" }),
        }),
      );
      expect(harness.tx.run.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ trigger: "tickets", botId: "bot-sender" }),
        }),
      );
    },
  );

  it("stays settled when a duplicate completion of a non-replyable source replays", async () => {
    const harness = deps({ hopBlocks: sourceWith("fyi"), board, ticket });
    const first = await returnBotMessageOutcome(harness.deps, helperRun, analyst, "Noted.");
    const second = await returnBotMessageOutcome(harness.deps, helperRun, analyst, "Noted.");

    expect(first).toBe(true);
    expect(second).toBe(true);
    expect(harness.tx.ticketComment.create).not.toHaveBeenCalled();
    expect(harness.tx.run.create).not.toHaveBeenCalled();
  });

  it("keeps a forced failure return off the owner's unread chats for ticket collaboration", async () => {
    // The requester is no longer the ticket's assignee (helper-to-helper), so the
    // failure text still reaches it as a chat message — without the forced unread
    // mark an ordinary failure return would leave on both owner-facing chats.
    const harness = deps({
      hopBlocks: sourceWith("request"),
      board,
      ticket: { id: "ticket-7", assigneeBotId: "bot-other" },
      bots: [
        { id: "bot-target", name: "Analyst", title: "", thread: { id: "thread-target" } },
        { id: "bot-sender", name: "Researcher", title: "", thread: { id: "thread-sender" } },
      ],
    });
    const returned = await returnBotMessageOutcome(
      harness.deps,
      helperRun,
      analyst,
      "Could not complete the delegated request.",
      "status",
      { forceUnread: true },
    );

    expect(returned).toBe(true);
    expect(harness.unreadMarks()).toHaveLength(0);
    expect(
      harness.tx.message.create.mock.calls.some(([call]) => call.data.threadId === "thread-sender"),
    ).toBe(true);
    // The exchange is still recorded on the ticket.
    expect(harness.tx.ticketComment.create).toHaveBeenCalledTimes(1);
  });
});

describe("ticket hop lineage", () => {
  const board = { id: "board-1", ticketPrefix: "OPS" };
  const ticket = { id: "ticket-7", assigneeBotId: "bot-sender" };
  const ticketRun = { ...run, trigger: "tickets" as const, taskId: "task-wake" };
  const helperRun = {
    ...run,
    id: "run-2",
    threadId: "thread-target",
    botId: "bot-target",
    sourceMessageId: "message-source",
  };
  const analyst = { id: "bot-target", name: "Analyst" };
  const clarification = [
    {
      kind: "bot_message_received",
      fromBotId: "bot-sender",
      fromBotName: "Researcher",
      text: "What quota applies?",
      hop: 1,
      intent: "request",
      ticketRef: "OPS-7",
    },
  ];
  const inboundToHelper = (harness: ReturnType<typeof deps>) =>
    harness.tx.message.create.mock.calls
      .map(([call]) => call.data)
      .filter((data) => data.threadId === "thread-target")
      .at(-1);

  it("continues the hop across a ticket wake instead of restarting at one", async () => {
    const harness = deps({
      taskPrompt: "Work on ticket OPS-7. Read it with ticket_get.",
      hopBlocks: clarification,
      board,
      ticket,
    });
    // Cycle 1: the assignee's ticket run (person-started, no ancestry) asks the helper.
    const asked = await messageBot(harness.deps, ticketRun, sender, {
      bot_id: "bot-target",
      message: "What quota applies?",
    });
    expect(asked).toMatchObject({ ok: true });
    expect(inboundToHelper(harness)?.blocks?.[0]).toMatchObject({ hop: 1, ticketRef: "OPS-7" });

    // The helper's outcome lands on the ticket and wakes the assignee with lineage.
    const returned = await returnBotMessageOutcome(
      harness.deps,
      helperRun,
      analyst,
      "Quota is five.",
    );
    expect(returned).toBe(true);
    const wake = harness.tx.run.create.mock.calls.at(-1)?.[0]?.data;
    expect(wake).toMatchObject({
      trigger: "tickets",
      botId: "bot-sender",
      sourceMessageId: "message-source",
    });

    // Cycle 2: the woken assignee continues the same bounded chain, not a fresh one.
    const askedAgain = await messageBot(
      harness.deps,
      { ...ticketRun, id: "run-wake", sourceMessageId: "message-source" },
      sender,
      { bot_id: "bot-target", message: "And the region?" },
    );
    expect(askedAgain).toMatchObject({ ok: true });
    expect(inboundToHelper(harness)?.blocks?.[0]).toMatchObject({ hop: 2 });
  });

  it("refuses the next bot message once the cycle exhausts the hop limit", async () => {
    const harness = deps({
      taskPrompt: "Work on ticket OPS-7.",
      hopBlocks: [{ ...clarification[0], hop: BOT_MESSAGE_MAX_HOPS }],
      board,
      ticket,
    });
    const refused = await messageBot(
      harness.deps,
      { ...ticketRun, sourceMessageId: "message-source" },
      sender,
      { bot_id: "bot-target", message: "One more thing" },
    );

    expect(refused).toMatchObject({ ok: false });
    if (!refused.ok) {
      expect(refused.error).toContain("limit reached");
      expect(refused.error).toContain("ticket");
    }
    expect(harness.tx.message.create).not.toHaveBeenCalled();
    expect(harness.tx.task.create).not.toHaveBeenCalled();
    expect(harness.tx.run.create).not.toHaveBeenCalled();
    expect(harness.enqueue).not.toHaveBeenCalled();
  });

  it("keeps the wake lineage when the delivery transaction retries", async () => {
    const harness = deps({
      hopBlocks: clarification,
      board,
      ticket,
      transactionConflictOnce: true,
    });
    const returned = await returnBotMessageOutcome(
      harness.deps,
      helperRun,
      analyst,
      "Quota is five.",
    );

    expect(returned).toBe(true);
    const wake = harness.tx.run.create.mock.calls.at(-1)?.[0]?.data;
    expect(wake).toMatchObject({
      trigger: "tickets",
      sourceMessageId: "message-source",
    });
    expect(harness.tx.ticketComment.create).toHaveBeenCalledTimes(1);
  });
});
