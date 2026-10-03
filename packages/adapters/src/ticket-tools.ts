import type { TicketStatus } from "@rakazo/contracts";
import {
  isTicketCompletedStatus,
  TICKET_COMMENT_MAX_LENGTH,
  TICKET_DESCRIPTION_MAX_LENGTH,
  TICKET_TITLE_MAX_LENGTH,
  TicketStatusSchema,
} from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import {
  allocateTicketNumber,
  coerceTicketPriority,
  ensureBoard,
  findTicket,
  listTicketComments,
  toTicketCommentDto,
  toTicketDto,
} from "@rakazo/db";
import type { TicketChangeNotifier } from "./ticket-changes.js";

export type TicketToolDeps = {
  prisma: PrismaClient;
  onTicketChange?: TicketChangeNotifier;
};

const STATUS_VALUES = TicketStatusSchema.options.join(", ");
const STATUS_ERROR = `status must be one of ${STATUS_VALUES}.`;

function coerceInputStatus(value: string | undefined): TicketStatus | undefined {
  if (value === undefined) return undefined;
  const parsed = TicketStatusSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

async function botInSpace(deps: TicketToolDeps, spaceId: string, botId: string): Promise<boolean> {
  const bot = await deps.prisma.bot.findFirst({
    where: { id: botId, spaceId, archivedAt: null },
    select: { id: true },
  });
  return Boolean(bot);
}

function normalizeTitle(value: string): { title: string } | { error: string } {
  const title = value.trim();
  if (!title) return { error: "title is required." };
  if (title.length > TICKET_TITLE_MAX_LENGTH) {
    return { error: `title must be at most ${TICKET_TITLE_MAX_LENGTH} characters.` };
  }
  return { title };
}

function normalizeDescription(value: string): { description: string | null } | { error: string } {
  const trimmed = value.trim();
  if (trimmed.length > TICKET_DESCRIPTION_MAX_LENGTH) {
    return {
      error: `description must be at most ${TICKET_DESCRIPTION_MAX_LENGTH} characters.`,
    };
  }
  return { description: trimmed || null };
}

/** Unknown or legacy priority strings fall back to `normal`, like the DTO mapper. */
function normalizePriority(value: string) {
  return coerceTicketPriority(value);
}

export async function listBoardTickets(
  deps: TicketToolDeps,
  input: {
    spaceId: string;
    status?: string;
    assigneeBotId?: string;
  },
) {
  let status: TicketStatus | undefined;
  if (input.status !== undefined) {
    status = coerceInputStatus(input.status);
    if (!status) return { error: STATUS_ERROR };
  }
  const board = await ensureBoard(deps.prisma, input.spaceId);
  const rows = await deps.prisma.ticket.findMany({
    where: {
      spaceId: input.spaceId,
      boardId: board.id,
      ...(status ? { status } : {}),
      ...(input.assigneeBotId ? { assigneeBotId: input.assigneeBotId } : {}),
    },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
  });
  return { tickets: rows.map((row) => toTicketDto(row, board.ticketPrefix)) };
}

export async function getTicket(deps: TicketToolDeps, input: { spaceId: string; ref: string }) {
  const ref = input.ref.trim();
  if (!ref) return { error: "ref is required." };
  const board = await ensureBoard(deps.prisma, input.spaceId);
  const row =
    (await findTicket(deps.prisma, input.spaceId, board, { ref })) ??
    (await findTicket(deps.prisma, input.spaceId, board, { id: ref }));
  if (!row) return { error: `Ticket ${ref} not found.` };
  const comments = await listTicketComments(deps.prisma, input.spaceId, row.id);
  return {
    ticket: toTicketDto(row, board.ticketPrefix),
    comments: comments.map(toTicketCommentDto),
  };
}

export async function createTicket(
  deps: TicketToolDeps,
  input: {
    spaceId: string;
    botId: string;
    userId?: string;
    title: string;
    description?: string;
    priority?: string;
    ownerBotId?: string;
  },
) {
  const normalized = normalizeTitle(input.title);
  if ("error" in normalized) return normalized;
  const { title } = normalized;

  let description: string | null = null;
  if (input.description !== undefined) {
    const result = normalizeDescription(input.description);
    if ("error" in result) return result;
    description = result.description;
  }

  const priority = input.priority !== undefined ? normalizePriority(input.priority) : "normal";

  const ownerBotId = input.ownerBotId ?? input.botId;
  if (!(await botInSpace(deps, input.spaceId, ownerBotId))) {
    return { error: "ownerBotId must be a bot in this space." };
  }

  const board = await ensureBoard(deps.prisma, input.spaceId);
  const row = await deps.prisma.$transaction(async (tx) => {
    const number = await allocateTicketNumber(tx, board.id);
    return tx.ticket.create({
      data: {
        boardId: board.id,
        spaceId: input.spaceId,
        number,
        title,
        description,
        priority,
        status: "todo",
        assigneeBotId: ownerBotId,
        createdByBotId: input.botId,
        createdByUserId: input.userId ?? null,
        completedAt: null,
      },
    });
  });
  await deps.onTicketChange?.({
    spaceId: input.spaceId,
    boardId: board.id,
    ticketId: row.id,
    assigneeBotId: row.assigneeBotId,
    actorBotId: input.botId,
    wakeAssignee: true,
  });
  return { ticket: toTicketDto(row, board.ticketPrefix) };
}

export async function moveTicket(
  deps: TicketToolDeps,
  input: { spaceId: string; id: string; status: string },
) {
  const status = coerceInputStatus(input.status);
  if (!status) return { error: STATUS_ERROR };
  const board = await ensureBoard(deps.prisma, input.spaceId);
  const existing = await findTicket(deps.prisma, input.spaceId, board, { id: input.id });
  if (!existing) return { error: `Ticket ${input.id} not found.` };
  const row = await deps.prisma.ticket.update({
    where: { id: existing.id },
    data: {
      status,
      completedAt: isTicketCompletedStatus(status) ? (existing.completedAt ?? new Date()) : null,
    },
  });
  await deps.onTicketChange?.({
    spaceId: input.spaceId,
    boardId: row.boardId,
    ticketId: row.id,
    assigneeBotId: row.assigneeBotId,
    wakeAssignee: false,
  });
  return { ticket: toTicketDto(row, board.ticketPrefix) };
}

export async function updateTicket(
  deps: TicketToolDeps,
  input: {
    spaceId: string;
    id: string;
    title?: string;
    description?: string;
    priority?: string;
  },
) {
  if (
    input.title === undefined &&
    input.description === undefined &&
    input.priority === undefined
  ) {
    return { error: "Provide title, description, or priority." };
  }
  const board = await ensureBoard(deps.prisma, input.spaceId);
  const existing = await findTicket(deps.prisma, input.spaceId, board, { id: input.id });
  if (!existing) return { error: `Ticket ${input.id} not found.` };

  const data: { title?: string; description?: string | null; priority?: string } = {};
  if (input.title !== undefined) {
    const result = normalizeTitle(input.title);
    if ("error" in result) return result;
    data.title = result.title;
  }
  if (input.description !== undefined) {
    const result = normalizeDescription(input.description);
    if ("error" in result) return result;
    data.description = result.description;
  }
  if (input.priority !== undefined) {
    data.priority = normalizePriority(input.priority);
  }
  const row = await deps.prisma.ticket.update({ where: { id: existing.id }, data });
  await deps.onTicketChange?.({
    spaceId: input.spaceId,
    boardId: row.boardId,
    ticketId: row.id,
    assigneeBotId: row.assigneeBotId,
    wakeAssignee: false,
  });
  return { ticket: toTicketDto(row, board.ticketPrefix) };
}

export async function closeTicket(
  deps: TicketToolDeps,
  input: {
    spaceId: string;
    botId: string;
    userId?: string;
    id: string;
    comment?: string;
  },
) {
  let comment: string | null = null;
  if (input.comment !== undefined) {
    const body = input.comment.trim();
    if (!body) return { error: "comment cannot be empty." };
    if (body.length > TICKET_COMMENT_MAX_LENGTH) {
      return { error: `comment must be at most ${TICKET_COMMENT_MAX_LENGTH} characters.` };
    }
    comment = body;
  }
  const board = await ensureBoard(deps.prisma, input.spaceId);
  const existing = await findTicket(deps.prisma, input.spaceId, board, { id: input.id });
  if (!existing) return { error: `Ticket ${input.id} not found.` };
  const result = await deps.prisma.$transaction(async (tx) => {
    const ticket = await tx.ticket.update({
      where: { id: existing.id },
      data: { status: "closed", completedAt: existing.completedAt ?? new Date() },
    });
    const created = comment
      ? await tx.ticketComment.create({
          data: {
            ticketId: existing.id,
            spaceId: input.spaceId,
            authorBotId: input.botId,
            authorUserId: input.userId ?? null,
            body: comment,
          },
        })
      : null;
    return { ticket, comment: created };
  });
  await deps.onTicketChange?.({
    spaceId: input.spaceId,
    boardId: result.ticket.boardId,
    ticketId: result.ticket.id,
    assigneeBotId: result.ticket.assigneeBotId,
    wakeAssignee: false,
  });
  return {
    ticket: toTicketDto(result.ticket, board.ticketPrefix),
    ...(result.comment ? { comment: toTicketCommentDto(result.comment) } : {}),
  };
}

export async function commentTicket(
  deps: TicketToolDeps,
  input: {
    spaceId: string;
    botId: string;
    userId?: string;
    id: string;
    body: string;
  },
) {
  const body = input.body.trim();
  if (!body) return { error: "body is required." };
  if (body.length > TICKET_COMMENT_MAX_LENGTH) {
    return { error: `body must be at most ${TICKET_COMMENT_MAX_LENGTH} characters.` };
  }
  const board = await ensureBoard(deps.prisma, input.spaceId);
  const ticket = await findTicket(deps.prisma, input.spaceId, board, { id: input.id });
  if (!ticket) return { error: `Ticket ${input.id} not found.` };
  const row = await deps.prisma.$transaction(async (tx) => {
    const created = await tx.ticketComment.create({
      data: {
        ticketId: ticket.id,
        spaceId: input.spaceId,
        authorBotId: input.botId,
        authorUserId: input.userId ?? null,
        body,
      },
    });
    await tx.ticket.update({ where: { id: ticket.id }, data: { updatedAt: new Date() } });
    return created;
  });
  await deps.onTicketChange?.({
    spaceId: input.spaceId,
    boardId: ticket.boardId,
    ticketId: ticket.id,
    assigneeBotId: ticket.assigneeBotId,
    wakeAssignee: false,
  });
  return { comment: toTicketCommentDto(row) };
}

export async function assignTicket(
  deps: TicketToolDeps,
  input: { spaceId: string; botId: string; id: string; ownerBotId: string },
) {
  const board = await ensureBoard(deps.prisma, input.spaceId);
  const existing = await findTicket(deps.prisma, input.spaceId, board, { id: input.id });
  if (!existing) return { error: `Ticket ${input.id} not found.` };
  if (!(await botInSpace(deps, input.spaceId, input.ownerBotId))) {
    return { error: "ownerBotId must be a bot in this space." };
  }
  const row = await deps.prisma.ticket.update({
    where: { id: existing.id },
    data: { assigneeBotId: input.ownerBotId, assigneeUserId: null },
  });
  await deps.onTicketChange?.({
    spaceId: input.spaceId,
    boardId: row.boardId,
    ticketId: row.id,
    assigneeBotId: row.assigneeBotId,
    actorBotId: input.botId,
    wakeAssignee: true,
  });
  return { ticket: toTicketDto(row, board.ticketPrefix) };
}
