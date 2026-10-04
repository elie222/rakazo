import { describe, expect, it, vi } from "vitest";
import {
  assignTicket,
  closeTicket,
  commentTicket,
  createTicket,
  getTicket,
  listBoardTickets,
  moveTicket,
  setTicketCriterion,
  updateTicket,
} from "./ticket-tools.js";

const NOW = new Date("2026-01-01T00:00:00.000Z");

/** Adds the history table and a self-referencing transaction to a mocked client. */
function withTransaction<T extends object>(prisma: T) {
  const client = {
    ticketEvent: { createMany: vi.fn(async () => ({ count: 0 })) },
    ticketComment: { create: vi.fn(async () => ({})) },
    ...prisma,
    $transaction: vi.fn(),
  };
  client.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
    fn(client),
  );
  return client;
}

function board(overrides: Record<string, unknown> = {}) {
  return {
    id: "board-1",
    spaceId: "ws",
    name: "Board",
    ticketPrefix: "RAK",
    nextNumber: 1,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

/** `ensureBoard` reads the space name to replace the placeholder board name. */
function boardSpace() {
  const row = board();
  return {
    board: {
      findUnique: vi.fn(async () => row),
      upsert: vi.fn(async () => row),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ ...row, ...data })),
    },
    space: { findUnique: vi.fn(async () => ({ name: "Personal" })) },
  };
}

function ticket(overrides: Record<string, unknown> = {}) {
  return {
    id: "t1",
    boardId: "board-1",
    spaceId: "ws",
    number: 1,
    title: "Ticket",
    description: null,
    acceptanceCriteria: [],
    statusChangedAt: NOW,
    status: "todo",
    priority: null,
    assigneeBotId: "bot-1",
    assigneeUserId: null,
    createdByBotId: null,
    createdByUserId: null,
    createdAt: NOW,
    updatedAt: NOW,
    completedAt: null,
    ...overrides,
  };
}

describe("ticket tools", () => {
  it("lists tickets strictly within the space and board", async () => {
    const findMany = vi.fn(async () => [ticket({ number: 1, status: "doing" })]);
    const prisma = {
      ...boardSpace(),
      ticket: { findMany },
    };

    const result = await listBoardTickets({ prisma } as never, {
      spaceId: "ws",
      status: "doing",
    });

    expect(findMany).toHaveBeenCalledWith({
      where: { spaceId: "ws", boardId: "board-1", status: "doing" },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 51,
    });
    expect(result).toEqual({ tickets: [expect.objectContaining({ ref: "RAK-1" })] });
  });

  it("leaves closed tickets out of an unfiltered list and shortens descriptions", async () => {
    const findMany = vi.fn(async () => [ticket({ number: 2, description: "x".repeat(500) })]);
    const prisma = { ...boardSpace(), ticket: { findMany } };

    const result = await listBoardTickets({ prisma } as never, { spaceId: "ws" });

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { spaceId: "ws", boardId: "board-1", status: { not: "closed" } },
        take: 51,
      }),
    );
    const listed = (result as { tickets: { description: string }[] }).tickets[0]!;
    expect(listed.description).toHaveLength(200);
    expect(listed.description.endsWith("…")).toBe(true);
  });

  it("pages older tickets with a cursor and rejects a bad one", async () => {
    const rows = Array.from({ length: 51 }, (_, index) =>
      ticket({
        id: `t${String(index).padStart(2, "0")}`,
        number: index + 1,
        createdAt: new Date(NOW.getTime() - index * 1000),
      }),
    );
    const findMany = vi.fn(async (_query: unknown) => rows);
    const prisma = { ...boardSpace(), ticket: { findMany } };

    const first = await listBoardTickets({ prisma } as never, { spaceId: "ws" });
    expect(first).toEqual({
      tickets: expect.any(Array),
      nextCursor: expect.any(String),
    });
    const page = first as { tickets: { id: string }[]; nextCursor: string };
    expect(page.tickets).toHaveLength(50);
    expect(page.tickets[49]?.id).toBe("t49");

    await listBoardTickets({ prisma } as never, { spaceId: "ws", cursor: page.nextCursor });
    expect(findMany.mock.calls[1]?.[0]).toEqual({
      where: {
        spaceId: "ws",
        boardId: "board-1",
        status: { not: "closed" },
        OR: [
          { createdAt: { lt: rows[49]!.createdAt } },
          { createdAt: rows[49]!.createdAt, id: { lt: "t49" } },
        ],
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 51,
    });

    const invalid = await listBoardTickets({ prisma } as never, {
      spaceId: "ws",
      cursor: "not-a-cursor",
    });
    expect(invalid).toEqual({ error: "cursor is invalid." });
  });

  it("keys the cursor on an immutable column, so a later edit cannot hide a ticket", async () => {
    const created = (index: number) => new Date(NOW.getTime() - index * 1000);
    const rows = Array.from({ length: 51 }, (_, index) =>
      ticket({
        id: `t${String(index).padStart(2, "0")}`,
        number: index + 1,
        createdAt: created(index),
      }),
    );
    const findMany = vi.fn(async (_query: unknown) => rows);
    const prisma = { ...boardSpace(), ticket: { findMany } };

    const first = await listBoardTickets({ prisma } as never, { spaceId: "ws" });
    const cursor = (first as { nextCursor: string }).nextCursor;

    // The last ticket sits below the first page and is edited between the two
    // calls. Its `updatedAt` is now the newest on the board, which is the case
    // that used to move it above the cursor and out of the scan.
    rows[50]!.updatedAt = new Date(NOW.getTime() + 60_000);

    await listBoardTickets({ prisma } as never, { spaceId: "ws", cursor });

    expect(findMany.mock.calls[1]?.[0]).toEqual({
      where: {
        spaceId: "ws",
        boardId: "board-1",
        status: { not: "closed" },
        OR: [{ createdAt: { lt: created(49) } }, { createdAt: created(49), id: { lt: "t49" } }],
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 51,
    });
    // The page key is the immutable `createdAt`, so the edited ticket stays ahead.
    const decoded = Buffer.from(cursor, "base64url").toString("utf8");
    expect(decoded).toBe(`${created(49).toISOString()}|t49`);
    expect(decoded).not.toContain(rows[50]!.updatedAt.toISOString());
  });

  it("rejects an unknown status filter", async () => {
    const result = await listBoardTickets(
      { prisma: { board: { upsert: vi.fn() } } as never },
      { spaceId: "ws", status: "archived" },
    );
    expect(result).toEqual({ error: expect.stringContaining("status must be one of") });
  });

  it("allocates a race-safe number and defaults the owner to the calling bot", async () => {
    const update = vi.fn(async () => ({ nextNumber: 2 }));
    const create = vi.fn(async ({ data }: { data: Record<string, unknown> }) =>
      ticket({
        number: data.number,
        title: data.title,
        status: data.status,
        createdByBotId: data.createdByBotId,
        createdByUserId: data.createdByUserId,
        assigneeBotId: data.assigneeBotId,
      }),
    );
    const prisma = {
      ...boardSpace(),
      bot: { findFirst: vi.fn(async () => ({ id: "bot-1" })) },
      $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({ board: { update }, ticket: { create }, ticketEvent: { createMany: vi.fn() } }),
      ),
    };

    const result = await createTicket({ prisma } as never, {
      spaceId: "ws",
      botId: "bot-1",
      userId: "user-1",
      title: "  Ship it  ",
    });

    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        number: 1,
        title: "Ship it",
        createdByBotId: "bot-1",
        createdByUserId: "user-1",
        assigneeBotId: "bot-1",
      }),
    });
    expect(result).toEqual({ ticket: expect.objectContaining({ ref: "RAK-1" }) });
  });

  it("creates with an explicit owner in the space", async () => {
    const update = vi.fn(async () => ({ nextNumber: 2 }));
    const create = vi.fn(async ({ data }: { data: Record<string, unknown> }) =>
      ticket({ number: data.number, assigneeBotId: data.assigneeBotId }),
    );
    const prisma = {
      ...boardSpace(),
      bot: { findFirst: vi.fn(async () => ({ id: "bot-2" })) },
      $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({ board: { update }, ticket: { create }, ticketEvent: { createMany: vi.fn() } }),
      ),
    };

    await createTicket({ prisma } as never, {
      spaceId: "ws",
      botId: "bot-1",
      title: "Ship it",
      ownerBotId: "bot-2",
    });

    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({ assigneeBotId: "bot-2" }),
    });
  });

  it("rejects an archived bot as owner", async () => {
    const findFirst = vi.fn(async () => null);
    const prisma = {
      ...boardSpace(),
      bot: { findFirst },
    };
    const created = await createTicket({ prisma } as never, {
      spaceId: "ws",
      botId: "bot-1",
      title: "Ship it",
      ownerBotId: "bot-archived",
    });
    expect(findFirst).toHaveBeenCalledWith({
      where: { id: "bot-archived", spaceId: "ws", archivedAt: null },
      select: { id: true },
    });
    expect(created).toEqual({ error: "ownerBotId must be a bot in this space." });

    const assigned = await assignTicket(
      {
        prisma: {
          ...boardSpace(),
          bot: { findFirst },
          ticket: { findFirst: vi.fn(async () => ticket({ id: "t1" })) },
        },
      } as never,
      { spaceId: "ws", id: "t1", botId: "bot-1", ownerBotId: "bot-archived" },
    );
    expect(assigned).toEqual({ error: "ownerBotId must be a bot in this space." });
    expect(findFirst).toHaveBeenLastCalledWith({
      where: { id: "bot-archived", spaceId: "ws", archivedAt: null },
      select: { id: true },
    });
  });

  it("rejects an owner that is not a bot in the space", async () => {
    const prisma = {
      ...boardSpace(),
      bot: { findFirst: vi.fn(async () => null) },
    };
    const result = await createTicket({ prisma } as never, {
      spaceId: "ws",
      botId: "bot-1",
      title: "Ship it",
      ownerBotId: "foreign",
    });
    expect(result).toEqual({ error: "ownerBotId must be a bot in this space." });
  });

  it("resolves a ticket by reference and includes its comments", async () => {
    const findFirst = vi.fn(async ({ where }: { where: { number?: number } }) =>
      where.number === 5 ? ticket({ id: "t5", number: 5 }) : null,
    );
    const commentFindMany = vi.fn(async () => [
      {
        id: "c1",
        ticketId: "t5",
        body: "first",
        authorBotId: "bot-1",
        authorUserId: null,
        createdAt: NOW,
        updatedAt: NOW,
      },
    ]);
    const prisma = {
      ...boardSpace(),
      ticket: { findFirst },
      ticketComment: { findMany: commentFindMany },
    };

    const found = await getTicket({ prisma } as never, { spaceId: "ws", ref: "RAK-5" });
    expect(findFirst).toHaveBeenCalledWith({
      where: { number: 5, spaceId: "ws", boardId: "board-1" },
    });
    expect(found).toEqual({
      ticket: expect.objectContaining({ ref: "RAK-5" }),
      comments: [expect.objectContaining({ body: "first" })],
    });
    expect(commentFindMany).toHaveBeenCalledWith({
      where: { ticketId: "t5", spaceId: "ws" },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });

    const missing = await getTicket({ prisma } as never, { spaceId: "ws", ref: "RAK-9" });
    expect(missing).toEqual({ error: "Ticket RAK-9 not found." });
  });

  it("moves a ticket only when it is inside the space", async () => {
    const findFirst = vi.fn(async () => ticket({ id: "t5" }));
    const update = vi.fn(async ({ data }: { data: Record<string, unknown> }) =>
      ticket({ id: "t5", status: data.status, completedAt: data.completedAt }),
    );
    const prisma = withTransaction({
      ...boardSpace(),
      ticket: { findFirst, update },
    });

    const result = await moveTicket({ prisma } as never, {
      spaceId: "ws",
      botId: "bot-1",
      id: "t5",
      status: "done",
    });

    expect(findFirst).toHaveBeenCalledWith({
      where: { id: "t5", spaceId: "ws", boardId: "board-1" },
    });
    expect(update.mock.calls[0]?.[0]).toEqual({
      where: { id: "t5" },
      data: {
        status: "done",
        statusChangedAt: expect.any(Date),
        updatedByBotId: "bot-1",
        completedAt: expect.any(Date),
      },
    });
    expect(result).toEqual({ ticket: expect.objectContaining({ status: "done" }) });
  });

  it("reports a move on a ticket outside the space", async () => {
    const prisma = {
      ...boardSpace(),
      ticket: { findFirst: vi.fn(async () => null) },
    };
    const result = await moveTicket({ prisma } as never, {
      spaceId: "ws",
      botId: "bot-1",
      id: "missing",
      status: "doing",
    });
    expect(result).toEqual({ error: "Ticket missing not found." });
  });

  it("updates title, description, and priority only within the space", async () => {
    const findFirst = vi.fn(async () => ticket({ id: "t5" }));
    const update = vi.fn(async ({ data }: { data: Record<string, unknown> }) =>
      ticket({ id: "t5", ...data }),
    );
    const prisma = withTransaction({
      ...boardSpace(),
      ticket: { findFirst, update },
    });

    const result = await updateTicket({ prisma } as never, {
      spaceId: "ws",
      botId: "bot-1",
      id: "t5",
      title: "  New title  ",
      priority: "  high  ",
    });

    expect(update).toHaveBeenCalledWith({
      where: { id: "t5" },
      data: { title: "New title", priority: "high", updatedByBotId: "bot-1" },
    });

    update.mockClear();
    await updateTicket({ prisma } as never, {
      spaceId: "ws",
      botId: "bot-2",
      id: "t5",
      title: "From elsewhere",
    });
    expect(update).toHaveBeenCalledWith({
      where: { id: "t5" },
      data: {
        title: "From elsewhere",
        updatedByBotId: "bot-2",
        externalUpdatedAt: expect.any(Date),
      },
    });
    expect(result).toEqual({ ticket: expect.objectContaining({ title: "New title" }) });
  });

  it("rejects an update with no fields and a ticket outside the space", async () => {
    const empty = await updateTicket(
      { prisma: { board: { upsert: vi.fn() } } as never },
      { spaceId: "ws", botId: "bot-1", id: "t5" },
    );
    expect(empty).toEqual({
      error: "Provide title, description, acceptanceCriteria, or priority.",
    });

    const missing = await updateTicket(
      {
        prisma: {
          ...boardSpace(),
          ticket: { findFirst: vi.fn(async () => null) },
        },
      } as never,
      { spaceId: "ws", botId: "bot-1", id: "missing", title: "x" },
    );
    expect(missing).toEqual({ error: "Ticket missing not found." });
  });

  it("closes a ticket and records the closing comment in one transaction", async () => {
    const update = vi.fn(async ({ data }: { data: Record<string, unknown> }) =>
      ticket({ id: "t5", status: data.status, completedAt: data.completedAt }),
    );
    const commentCreate = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
      id: "c1",
      ticketId: data.ticketId,
      body: data.body,
      authorBotId: data.authorBotId,
      authorUserId: data.authorUserId,
      createdAt: NOW,
      updatedAt: NOW,
    }));
    const prisma = {
      ...boardSpace(),
      ticket: { findFirst: vi.fn(async () => ticket({ id: "t5" })) },
      $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          ticket: { update },
          ticketComment: { create: commentCreate },
          ticketEvent: { createMany: vi.fn() },
        }),
      ),
    };

    const result = await closeTicket({ prisma } as never, {
      spaceId: "ws",
      botId: "bot-1",
      userId: "user-1",
      id: "t5",
      comment: "  done  ",
    });

    expect(update).toHaveBeenCalledWith({
      where: { id: "t5" },
      data: {
        status: "closed",
        statusChangedAt: expect.any(Date),
        completedAt: expect.any(Date),
        updatedByBotId: "bot-1",
      },
    });
    expect(commentCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ ticketId: "t5", authorBotId: "bot-1", body: "done" }),
    });
    expect(result).toEqual({
      ticket: expect.objectContaining({ status: "closed" }),
      comment: expect.objectContaining({ body: "done" }),
    });
  });

  it("comments on a ticket as the writing bot", async () => {
    const ticketComment = {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: "c1",
        ticketId: data.ticketId,
        body: data.body,
        authorBotId: data.authorBotId,
        authorUserId: data.authorUserId,
        createdAt: NOW,
        updatedAt: NOW,
      })),
    };
    const txTicket = { update: vi.fn(async () => ({})) };
    const prisma = {
      ...boardSpace(),
      ticket: { findFirst: vi.fn(async () => ticket({ id: "t7" })) },
      $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({ ticketComment, ticket: txTicket, ticketEvent: { createMany: vi.fn() } }),
      ),
    };

    const result = await commentTicket({ prisma } as never, {
      spaceId: "ws",
      botId: "bot-1",
      userId: "user-1",
      id: "t7",
      body: "  progress  ",
    });

    expect(txTicket.update).toHaveBeenCalledWith({
      where: { id: "t7" },
      data: { updatedAt: expect.any(Date), updatedByBotId: "bot-1" },
    });
    expect(result).toEqual({
      comment: expect.objectContaining({ authorBotId: "bot-1", body: "progress" }),
    });
  });

  it("reassigns the owner only to a bot in the space", async () => {
    const findFirstTicket = vi.fn(async () => ticket({ id: "t1" }));
    const update = vi.fn(async ({ data }: { data: Record<string, unknown> }) =>
      ticket({ id: "t1", assigneeBotId: data.assigneeBotId, assigneeUserId: data.assigneeUserId }),
    );
    const botFindFirst = vi.fn(async (): Promise<{ id: string } | null> => ({ id: "bot-2" }));
    const prisma = withTransaction({
      ...boardSpace(),
      bot: { findFirst: botFindFirst },
      ticket: { findFirst: findFirstTicket, update },
    });

    const assigned = await assignTicket({ prisma } as never, {
      spaceId: "ws",
      id: "t1",
      botId: "bot-1",
      ownerBotId: "bot-2",
    });
    expect(assigned).toEqual({ ticket: expect.objectContaining({ assigneeBotId: "bot-2" }) });
    expect(update).toHaveBeenCalledWith({
      where: { id: "t1" },
      data: {
        assigneeBotId: "bot-2",
        assigneeUserId: null,
        updatedByBotId: "bot-1",
        externalUpdatedAt: expect.any(Date),
      },
    });

    botFindFirst.mockResolvedValueOnce(null);
    const foreign = await assignTicket({ prisma } as never, {
      spaceId: "ws",
      id: "t1",
      botId: "bot-1",
      ownerBotId: "foreign",
    });
    expect(foreign).toEqual({ error: "ownerBotId must be a bot in this space." });
  });

  it("refuses to hand off with open criteria unless given a reason", async () => {
    const findFirst = vi.fn(async () =>
      ticket({
        id: "t5",
        status: "doing",
        acceptanceCriteria: [
          { text: "A", done: true },
          { text: "B", done: false },
        ],
      }),
    );
    const update = vi.fn(async ({ data }: { data: Record<string, unknown> }) =>
      ticket({ id: "t5", status: data.status }),
    );
    const prisma = withTransaction({ ...boardSpace(), ticket: { findFirst, update } });
    const input = { spaceId: "ws", botId: "bot-1", id: "t5", status: "review" };

    const refused = await moveTicket({ prisma } as never, input);
    expect(refused).toEqual({ error: expect.stringMatching(/not checked/) });
    expect(update).not.toHaveBeenCalled();

    const allowed = await moveTicket({ prisma } as never, { ...input, reason: "B is N/A" });
    expect(allowed).toEqual({ ticket: expect.objectContaining({ status: "review" }) });
    expect(prisma.ticketComment.create).toHaveBeenCalled();
  });

  it("requires a reason for blocked and for won't do", async () => {
    const findFirst = vi.fn(async () => ticket({ id: "t5", status: "doing" }));
    const prisma = withTransaction({
      ...boardSpace(),
      ticket: { findFirst, update: vi.fn(async () => ticket({ id: "t5" })) },
    });
    const blocked = await moveTicket({ prisma } as never, {
      spaceId: "ws",
      botId: "bot-1",
      id: "t5",
      status: "blocked",
    });
    expect(blocked).toEqual({ error: expect.stringMatching(/blocked on/) });
    const closed = await closeTicket({ prisma } as never, {
      spaceId: "ws",
      botId: "bot-1",
      id: "t5",
    });
    expect(closed).toEqual({ error: expect.stringMatching(/will not be done/) });
  });

  it("checks a criterion by position and rejects a bad index", async () => {
    const findFirst = vi.fn(async () =>
      ticket({
        id: "t5",
        acceptanceCriteria: [
          { text: "A", done: false },
          { text: "B", done: false },
        ],
      }),
    );
    const update = vi.fn(async ({ data }: { data: Record<string, unknown> }) =>
      ticket({ id: "t5", ...data }),
    );
    const prisma = withTransaction({ ...boardSpace(), ticket: { findFirst, update } });
    const base = { spaceId: "ws", botId: "bot-1", id: "t5" };

    const result = await setTicketCriterion({ prisma } as never, { ...base, index: 2, done: true });
    expect(update.mock.calls[0]?.[0].data.acceptanceCriteria).toEqual([
      { text: "A", done: false },
      { text: "B", done: true },
    ]);
    expect(result).toEqual({ ticket: expect.anything() });

    const bad = await setTicketCriterion({ prisma } as never, { ...base, index: 3, done: true });
    expect(bad).toEqual({ error: expect.stringMatching(/between 1 and 2/) });
  });
});
