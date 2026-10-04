import type { Board, Ticket, TicketComment, TicketPriority, TicketStatus } from "@rakazo/contracts";
import {
  parseTicketRef,
  reservedTicketNumber,
  TicketPrioritySchema,
  TicketStatusSchema,
  ticketRef,
} from "@rakazo/contracts";
import type { Prisma, PrismaClient } from "./client.js";

export type BoardRow = {
  id: string;
  spaceId: string;
  name: string;
  ticketPrefix: string;
  nextNumber: number;
  createdAt: Date;
  updatedAt: Date;
};

export type TicketRow = {
  id: string;
  boardId: string;
  spaceId: string;
  number: number;
  title: string;
  description: string | null;
  status: string;
  priority: string | null;
  assigneeBotId: string | null;
  assigneeUserId: string | null;
  createdByBotId: string | null;
  createdByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
};

export type TicketCommentRow = {
  id: string;
  ticketId: string;
  body: string;
  authorBotId: string | null;
  authorUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

/** New boards inherit the space name; this placeholder is replaced on first touch. */
const BOARD_PLACEHOLDER_NAME = "Board";

/**
 * Every space has exactly one board; create it on first touch. A board still
 * carrying the placeholder name adopts the space name, so existing live boards
 * pick up the change without a migration.
 */
export async function ensureBoard(prisma: PrismaClient, spaceId: string): Promise<BoardRow> {
  const existing = await prisma.board.findUnique({ where: { spaceId } });
  if (existing && existing.name !== BOARD_PLACEHOLDER_NAME) return existing;
  const space = await prisma.space.findUnique({
    where: { id: spaceId },
    select: { name: true },
  });
  const name = space?.name.trim() || BOARD_PLACEHOLDER_NAME;
  const board = await prisma.board.upsert({
    where: { spaceId },
    create: { spaceId, name },
    update: {},
  });
  if (board.name === BOARD_PLACEHOLDER_NAME && board.name !== name) {
    return prisma.board.update({ where: { id: board.id }, data: { name } });
  }
  return board;
}

/** All boards in a space, oldest first. */
export async function listBoards(prisma: PrismaClient, spaceId: string): Promise<BoardRow[]> {
  return prisma.board.findMany({
    where: { spaceId },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
}

/**
 * Atomically reserve the next ticket number for a board. The board's counter is
 * incremented in the same transaction as the insert, so concurrent creates get
 * distinct ascending numbers.
 */
export async function allocateTicketNumber(
  tx: Pick<Prisma.TransactionClient, "board">,
  boardId: string,
): Promise<number> {
  const incremented = await tx.board.update({
    where: { id: boardId },
    data: { nextNumber: { increment: 1 } },
    select: { nextNumber: true },
  });
  return reservedTicketNumber(incremented.nextNumber);
}

/** Find a ticket in a board by database id or by human reference such as `RAK-42`. */
export async function findTicket(
  prisma: PrismaClient,
  spaceId: string,
  board: { id: string; ticketPrefix: string },
  input: { id?: string; ref?: string },
): Promise<TicketRow | null> {
  if (input.id) {
    return prisma.ticket.findFirst({
      where: { id: input.id, spaceId, boardId: board.id },
    });
  }
  const parsed = input.ref ? parseTicketRef(input.ref, board.ticketPrefix) : null;
  if (!parsed) return null;
  return prisma.ticket.findFirst({
    where: { number: parsed.number, spaceId, boardId: board.id },
  });
}

export function toBoardDto(row: BoardRow): Board {
  return {
    id: row.id,
    spaceId: row.spaceId,
    name: row.name,
    ticketPrefix: row.ticketPrefix,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function coerceTicketStatus(value: string): TicketStatus {
  const parsed = TicketStatusSchema.safeParse(value);
  return parsed.success ? parsed.data : "todo";
}

/** Legacy free-text priorities fall back to `normal` so old rows keep rendering. */
export function coerceTicketPriority(value: string | null | undefined): TicketPriority {
  const parsed = TicketPrioritySchema.safeParse(typeof value === "string" ? value.trim() : value);
  return parsed.success ? parsed.data : "normal";
}

export function toTicketDto(row: TicketRow, ticketPrefix: string): Ticket {
  return {
    id: row.id,
    boardId: row.boardId,
    spaceId: row.spaceId,
    number: row.number,
    ref: ticketRef(ticketPrefix, row.number),
    title: row.title,
    description: row.description,
    status: coerceTicketStatus(row.status),
    priority: coerceTicketPriority(row.priority),
    assigneeBotId: row.assigneeBotId,
    createdByBotId: row.createdByBotId,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
  };
}

/**
 * Stamp who last changed a ticket. A change by someone other than the assignee
 * also records `externalUpdatedAt`, which the assignee's own later edits do not
 * clear, so a self-edit cannot hide an unseen external update.
 */
export function ticketEditorStamp(
  actorBotId: string | null,
  assigneeBotId: string | null,
  now = new Date(),
): { updatedByBotId: string | null; externalUpdatedAt?: Date } {
  if (actorBotId !== null && actorBotId === assigneeBotId) {
    return { updatedByBotId: actorBotId };
  }
  return { updatedByBotId: actorBotId, externalUpdatedAt: now };
}

/** Comments for a ticket, oldest first, scoped to the space. */
export async function listTicketComments(
  prisma: Pick<PrismaClient, "ticketComment">,
  spaceId: string,
  ticketId: string,
): Promise<TicketCommentRow[]> {
  return prisma.ticketComment.findMany({
    where: { ticketId, spaceId },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
}

export function toTicketCommentDto(row: TicketCommentRow): TicketComment {
  return {
    id: row.id,
    ticketId: row.ticketId,
    body: row.body,
    authorBotId: row.authorBotId,
    authorUserId: row.authorUserId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
