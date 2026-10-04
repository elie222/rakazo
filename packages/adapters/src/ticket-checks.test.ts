import type { JobPublisher } from "@rakazo/adapter-kit";
import { ACTIONABLE_TICKET_STATUSES } from "@rakazo/contracts";
import { ACTIVE_RUN_STATUSES } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import type { TicketCheckDeps } from "./ticket-checks.js";
import { reconcileTicketChecks, runTicketChecks } from "./ticket-checks.js";

const NOW = new Date("2026-06-01T12:00:00.000Z");
const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * 60 * 60 * 1000);

function botRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "bot-1",
    spaceId: "space-1",
    userId: "user-1",
    name: "Helper",
    ticketsCheckedAt: null,
    ticketsWakeAt: null,
    thread: { id: "thread-1" },
    ...overrides,
  };
}

function ticketRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "ticket-1",
    boardId: "board-1",
    number: 1,
    title: "Fix the thing",
    status: "todo",
    priority: "high",
    assigneeBotId: "bot-1",
    updatedAt: hoursAgo(1),
    ...overrides,
  };
}

function depsFor(options: {
  bots?: unknown[];
  tickets?: unknown[];
  activeBotIds?: string[];
  claimCount?: number;
  claimActiveRun?: boolean;
  priorWakeAt?: Date | null;
}) {
  const enqueue = vi.fn(async () => undefined);
  const taskCreate = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
    id: "task-1",
    ...data,
  }));
  const runCreate = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
    id: "run-1",
    ...data,
  }));
  const txBotUpdateMany = vi.fn(async () => ({ count: options.claimCount ?? 1 }));
  const txBotUpdate = vi.fn(async () => ({ id: "bot-1" }));
  const txRunFindFirst = vi.fn(async () => (options.claimActiveRun ? { id: "run-active" } : null));
  const commentFindMany = vi.fn(async () => []);
  const tx = {
    bot: {
      updateMany: txBotUpdateMany,
      update: txBotUpdate,
      findUnique: vi.fn(async () => ({ ticketsWakeAt: options.priorWakeAt ?? null })),
    },
    task: { create: taskCreate },
    run: { create: runCreate, findFirst: txRunFindFirst },
  };
  const botUpdateMany = vi.fn(async () => ({ count: 1 }));
  const prisma = {
    bot: {
      findMany: vi.fn(async () => options.bots ?? [botRow()]),
      updateMany: botUpdateMany,
    },
    ticket: { findMany: vi.fn(async () => options.tickets ?? [ticketRow()]) },
    ticketComment: { findMany: commentFindMany },
    run: {
      findMany: vi.fn(async () => (options.activeBotIds ?? []).map((botId) => ({ botId }))),
    },
    board: { findUnique: vi.fn(async () => ({ ticketPrefix: "RAK" })) },
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(tx)),
  };
  const boardNotify = vi.fn(async () => undefined);
  const deps: TicketCheckDeps = {
    prisma: prisma as unknown as PrismaClient,
    jobs: { enqueue } as unknown as JobPublisher,
    boardEvents: { notify: boardNotify },
  };
  return {
    deps,
    enqueue,
    taskCreate,
    runCreate,
    botUpdateMany,
    txBotUpdateMany,
    txBotUpdate,
    txRunFindFirst,
    commentFindMany,
    boardNotify,
  };
}

describe("runTicketChecks", () => {
  it("starts one run and wakes the owner once for changed tickets", async () => {
    const { deps, enqueue, taskCreate, runCreate, botUpdateMany, boardNotify, commentFindMany } =
      depsFor({});
    await runTicketChecks(deps, { trigger: "periodic", now: NOW });

    expect(commentFindMany).toHaveBeenCalledWith({
      where: {
        ticket: {
          assigneeBotId: { in: ["bot-1"] },
          status: { in: [...ACTIONABLE_TICKET_STATUSES] },
        },
      },
      orderBy: [{ ticketId: "asc" }, { createdAt: "desc" }, { id: "desc" }],
      distinct: ["ticketId"],
      select: { ticketId: true, body: true },
    });

    expect(boardNotify).toHaveBeenCalledWith("space-1", { boardId: "board-1" });

    expect(taskCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ botId: "bot-1", threadId: "thread-1", status: "queued" }),
    });
    expect(taskCreate.mock.calls[0]?.[0].data.prompt).toContain("RAK-1");
    expect(runCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ botId: "bot-1", status: "queued", trigger: "tickets" }),
    });
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ name: "run.continue", payload: { runId: "run-1" } }),
    );
    expect(botUpdateMany).toHaveBeenCalledWith({
      where: { id: { in: ["bot-1"] } },
      data: { ticketsCheckedAt: NOW },
    });
  });

  it("does nothing while the bot already has an active run", async () => {
    const { deps, enqueue, taskCreate, botUpdateMany } = depsFor({ activeBotIds: ["bot-1"] });
    await runTicketChecks(deps, { trigger: "periodic", now: NOW });
    expect(taskCreate).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
    expect(botUpdateMany).not.toHaveBeenCalled();
  });

  it("does not advance ticketsCheckedAt when the wake is debounced", async () => {
    const bot = botRow({ ticketsWakeAt: new Date(NOW.getTime() - 60_000) });
    const { deps, taskCreate, botUpdateMany } = depsFor({ bots: [bot] });
    await runTicketChecks(deps, { trigger: "periodic", now: NOW });
    expect(taskCreate).not.toHaveBeenCalled();
    expect(botUpdateMany).not.toHaveBeenCalled();
  });

  it("skips a bot with no actionable tickets", async () => {
    const { deps, taskCreate, botUpdateMany } = depsFor({ tickets: [] });
    await runTicketChecks(deps, { trigger: "periodic", now: NOW });
    expect(taskCreate).not.toHaveBeenCalled();
    expect(botUpdateMany).toHaveBeenCalledWith({
      where: { id: { in: ["bot-1"] } },
      data: { ticketsCheckedAt: NOW },
    });
  });

  it("stays quiet when nothing changed and the ticket is fresh", async () => {
    const bot = botRow({ ticketsCheckedAt: hoursAgo(0.5) });
    const { deps, taskCreate, botUpdateMany } = depsFor({
      bots: [bot],
      tickets: [ticketRow({ updatedAt: hoursAgo(1) })],
    });
    await runTicketChecks(deps, { trigger: "periodic", now: NOW });
    expect(taskCreate).not.toHaveBeenCalled();
    expect(botUpdateMany).toHaveBeenCalledWith({
      where: { id: { in: ["bot-1"] } },
      data: { ticketsCheckedAt: NOW },
    });
  });

  it("does not treat the bot's own ticket edit as a change", async () => {
    const bot = botRow({ ticketsCheckedAt: hoursAgo(3) });
    const { deps, taskCreate } = depsFor({
      bots: [bot],
      tickets: [ticketRow({ updatedAt: hoursAgo(1), updatedByBotId: "bot-1" })],
    });
    await runTicketChecks(deps, { trigger: "periodic", now: NOW });
    expect(taskCreate).not.toHaveBeenCalled();
  });

  it("wakes for an edit someone else made after the last check", async () => {
    const bot = botRow({ ticketsCheckedAt: hoursAgo(3) });
    const { deps, taskCreate } = depsFor({
      bots: [bot],
      tickets: [ticketRow({ updatedAt: hoursAgo(1), updatedByBotId: null })],
    });
    await runTicketChecks(deps, { trigger: "periodic", now: NOW });
    expect(taskCreate).toHaveBeenCalledTimes(1);
  });

  it("reminds on a stale ticket even without a change", async () => {
    const bot = botRow({ ticketsCheckedAt: hoursAgo(0.5) });
    const { deps, taskCreate } = depsFor({
      bots: [bot],
      tickets: [ticketRow({ updatedAt: hoursAgo(5) })],
    });
    await runTicketChecks(deps, { trigger: "periodic", now: NOW });
    expect(taskCreate).toHaveBeenCalledTimes(1);
  });

  it("skips the wake when the debounce fence rejects the claim", async () => {
    const { deps, enqueue, taskCreate, botUpdateMany, txBotUpdateMany } = depsFor({
      claimCount: 0,
    });
    await runTicketChecks(deps, { trigger: "event", botId: "bot-1", now: NOW });
    expect(taskCreate).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
    expect(botUpdateMany).not.toHaveBeenCalled();
    expect(txBotUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [{ ticketsWakeAt: null }, { ticketsWakeAt: { lt: expect.any(Date) } }],
        }),
      }),
    );
  });

  it("aborts the claim when a run appears before the ticket run is created", async () => {
    const { deps, enqueue, taskCreate, runCreate, botUpdateMany, txBotUpdate, txRunFindFirst } =
      depsFor({ claimActiveRun: true, priorWakeAt: hoursAgo(1) });
    await runTicketChecks(deps, { trigger: "periodic", now: NOW });
    expect(taskCreate).not.toHaveBeenCalled();
    expect(runCreate).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
    expect(txRunFindFirst).toHaveBeenCalledWith({
      where: { botId: "bot-1", status: { in: [...ACTIVE_RUN_STATUSES] } },
      select: { id: true },
    });
    expect(txBotUpdate).toHaveBeenCalledWith({
      where: { id: "bot-1" },
      data: { ticketsWakeAt: hoursAgo(1) },
    });
    expect(botUpdateMany).not.toHaveBeenCalled();
  });

  it("advances ticketsCheckedAt after an event wake this process started", async () => {
    const { deps, taskCreate, botUpdateMany } = depsFor({});
    await runTicketChecks(deps, { trigger: "event", botId: "bot-1", now: NOW });
    expect(taskCreate).toHaveBeenCalledTimes(1);
    expect(botUpdateMany).toHaveBeenCalledWith({
      where: { id: { in: ["bot-1"] } },
      data: { ticketsCheckedAt: NOW },
    });
  });

  it("advances ticketsCheckedAt on an event sweep with no tickets", async () => {
    const { deps, taskCreate, botUpdateMany } = depsFor({ tickets: [] });
    await runTicketChecks(deps, { trigger: "event", botId: "bot-1", now: NOW });
    expect(taskCreate).not.toHaveBeenCalled();
    expect(botUpdateMany).toHaveBeenCalledWith({
      where: { id: { in: ["bot-1"] } },
      data: { ticketsCheckedAt: NOW },
    });
  });

  it("does not advance ticketsCheckedAt when another checker claimed the wake", async () => {
    const { deps, taskCreate, botUpdateMany } = depsFor({ claimCount: 0 });
    await runTicketChecks(deps, { trigger: "periodic", now: NOW });
    expect(taskCreate).not.toHaveBeenCalled();
    expect(botUpdateMany).not.toHaveBeenCalled();
  });
});

describe("reconcileTicketChecks", () => {
  function reconcileDeps(overdue: boolean) {
    const findFirst = vi.fn(async () => (overdue ? { id: "bot-2" } : null));
    const enqueue = vi.fn(async () => undefined);
    const deps = {
      prisma: { bot: { findFirst } } as unknown as PrismaClient,
      jobs: { enqueue } as unknown as JobPublisher,
    } satisfies TicketCheckDeps;
    return { deps, findFirst, enqueue };
  }

  it("re-enqueues the sweep when any bot is overdue, however fresh the others are", async () => {
    const { deps, findFirst, enqueue } = reconcileDeps(true);
    await reconcileTicketChecks(deps);
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          archivedAt: null,
          OR: [{ ticketsCheckedAt: null }, { ticketsCheckedAt: { lt: expect.any(Date) } }],
        }),
      }),
    );
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it("does nothing while every bot was checked inside the interval", async () => {
    const { deps, enqueue } = reconcileDeps(false);
    await reconcileTicketChecks(deps);
    expect(enqueue).not.toHaveBeenCalled();
  });
});
