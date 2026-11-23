import type { BackgroundJob, JobPublisher } from "@rakazo/adapter-kit";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { createJobReconciler } from "./job-reconciler.js";

/**
 * Recovery coverage for ticket-tagged bot-message outcomes, through the real
 * outcome-delivery path (no module mocks, unlike job-reconciler.test.ts): the
 * reconciler's scan must supply the deployment's Labs, the same configuration
 * the executor delivers with, or a deployment-wide board enablement recovers
 * the answer comment and outcome claim while the assignee stays idle.
 */
describe("createJobReconciler bot-message outcome recovery", () => {
  function publisher() {
    const enqueue = vi.fn(async (_job: BackgroundJob): Promise<void> => undefined);
    const jobs: JobPublisher = {
      enqueue,
      enqueueIn: async () => undefined,
      enqueueManyIn: async () => undefined,
      cancelIn: async () => undefined,
      cancel: async () => undefined,
      close: async () => undefined,
    };
    return { jobs, enqueue };
  }

  function harness() {
    // The answering bot's run: terminal, its outcome not yet returned, woken by
    // a ticket-tagged request from the assignee (a different bot).
    const terminalRun = {
      id: "run-answer",
      spaceId: "space-1",
      threadId: "thread-answer",
      botId: "bot-helper",
      userId: "user-1",
      sourceMessageId: "message-source",
      status: "completed",
      error: null,
      bot: { name: "Surveyor" },
    };
    const runFindMany = vi.fn(async (args: { where?: { trigger?: string } } = {}) =>
      args.where?.trigger === "bot_message" ? [terminalRun] : [],
    );
    const messageFindUnique = vi.fn(async (args: { where?: Record<string, unknown> }) => {
      if (args.where?.threadId_clientNonce) return null;
      return {
        blocks: [
          {
            kind: "bot_message_received",
            fromBotId: "bot-sender",
            fromBotName: "Researcher",
            text: "What quota applies to ticket OPS-7?",
            hop: 1,
            intent: "request",
            ticketRef: "OPS-7",
          },
        ],
        replyTo: null,
      };
    });
    // The claim the delivery transaction makes; a replay sees it already taken.
    let claimAvailable = true;
    const tx = {
      $queryRaw: vi.fn(async () => [{ id: "row" }]),
      space: { findUnique: vi.fn(async () => ({ deletingAt: null })) },
      message: {
        findUnique: messageFindUnique,
        create: vi.fn(async () => ({ id: "message-echo" })),
      },
      event: { create: vi.fn(async () => ({ seq: 7 })) },
      thread: {
        update: vi.fn(async () => ({ nextMessageSeq: 2, spaceId: "space-1", nextEventSeq: 8 })),
      },
      run: {
        findFirst: vi.fn(async () => ({ id: terminalRun.id })),
        findUnique: vi.fn(async () => ({
          status: "completed",
          startedAt: null,
          firstResponseAt: null,
          userId: "user-1",
          leaseOwner: null,
          leaseFence: 0,
        })),
        create: vi.fn(async () => ({ id: "run-wake" })),
        updateMany: vi.fn(async () => ({ count: claimAvailable ? 1 : 0 })),
      },
      bot: {
        findFirst: vi.fn(async () => ({
          id: "bot-sender",
          userId: "user-1",
          thread: { id: "thread-sender" },
        })),
      },
      // The assignee's owner has no personal board lab: only the deployment's
      // Labs can qualify the wake.
      user: { findUnique: vi.fn(async () => ({ labs: [] })) },
      task: { create: vi.fn(async () => ({ id: "task-wake" })) },
      ticketComment: { create: vi.fn(async () => ({ id: "comment-1" })) },
      ticket: {
        findFirst: vi.fn(async () => ({
          id: "ticket-7",
          assigneeBotId: "bot-sender",
          status: "doing",
          number: 7,
          board: { ticketPrefix: "OPS" },
        })),
        update: vi.fn(async () => ({})),
      },
    };
    const prisma = {
      run: { findMany: runFindMany, updateMany: vi.fn(async () => ({ count: 1 })) },
      routine: { findMany: vi.fn(async () => []) },
      computer: { findMany: vi.fn(async () => []) },
      message: {
        findUnique: messageFindUnique,
        // The answering run's final written response.
        findMany: vi.fn(async () => [
          { id: "m-1", blocks: [{ kind: "text", text: "Quota is five." }], clientNonce: null },
        ]),
      },
      bot: { findFirst: vi.fn(async () => ({ id: "bot-sender", name: "Researcher" })) },
      board: { findUnique: vi.fn(async () => ({ id: "board-1", ticketPrefix: "OPS" })) },
      ticket: { findFirst: vi.fn(async () => ({ id: "ticket-7", assigneeBotId: "bot-sender" })) },
      $transaction: vi.fn(async (fn: (client: unknown) => unknown) => fn(tx)),
    } as unknown as PrismaClient;
    const { jobs, enqueue } = publisher();
    const events = { notify: vi.fn() } as unknown as ThreadEvents;
    const onTicketChange = vi.fn(async () => undefined);
    const takeClaim = () => {
      claimAvailable = false;
    };
    return { prisma, jobs, events, enqueue, tx, takeClaim, onTicketChange };
  }

  it("recovers a ticket-tagged answer with the deployment's board lab, waking the assignee", async () => {
    const { prisma, jobs, events, enqueue, tx, onTicketChange } = harness();

    const reconciler = createJobReconciler(
      { prisma, jobs, events, deploymentLabs: ["board"], onTicketChange },
      { batchSize: 1 },
    );
    await reconciler.reconcileOnce();
    // The recovered comment refreshes the board, like every committed comment.
    expect(onTicketChange).toHaveBeenCalledWith({
      spaceId: "space-1",
      boardId: "board-1",
      ticketId: "ticket-7",
      assigneeBotId: null,
      wakeAssignee: false,
    });

    // The answer comment commits, authored by the replying bot.
    expect(tx.ticketComment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          ticketId: "ticket-7",
          spaceId: "space-1",
          authorBotId: "bot-helper",
          body: "Quota is five.",
        }),
      }),
    );
    expect(tx.ticket.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "ticket-7" }, data: { updatedAt: expect.any(Date) } }),
    );
    // The outcome claim commits in the same transaction.
    expect(tx.run.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "run-answer", botOutcomeReturnedAt: null },
        data: { botOutcomeReturnedAt: expect.any(Date) },
      }),
    );
    // The assignee — an active bot other than the replying one, whose owner has
    // no personal board lab — gets a durable queued ticket task and run that
    // inherits the answering run's source message (the hop lineage).
    expect(tx.task.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ botId: "bot-sender", status: "queued" }),
      }),
    );
    expect(tx.run.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          trigger: "tickets",
          botId: "bot-sender",
          status: "queued",
          sourceMessageId: "message-source",
        }),
      }),
    );
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ name: "run.continue", payload: { runId: "run-wake" } }),
    );
  });

  it("replays a recovered outcome without a second comment or continuation", async () => {
    const { prisma, jobs, events, tx, takeClaim, onTicketChange } = harness();

    const reconciler = createJobReconciler(
      { prisma, jobs, events, deploymentLabs: ["board"], onTicketChange },
      { batchSize: 1 },
    );
    await reconciler.reconcileOnce();
    takeClaim();
    // The scan still offers the run; the claim the first pass committed is what
    // a replay of the same terminal outcome sees in the delivery transaction.
    await reconciler.reconcileOnce();

    expect(tx.ticketComment.create).toHaveBeenCalledTimes(1);
    expect(tx.task.create).toHaveBeenCalledTimes(1);
    expect(tx.run.create).toHaveBeenCalledTimes(1);
    expect(onTicketChange).toHaveBeenCalledTimes(1);
  });
});
