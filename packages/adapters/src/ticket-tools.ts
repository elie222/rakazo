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
  ticketEditorStamp,
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

const LIST_TICKETS_LIMIT = 50;
const LIST_DESCRIPTION_CHARS = 200;

/**
 * The page key is the ticket's `createdAt` with `id` as the tiebreaker, because
 * both never change. A key on `updatedAt` would move a ticket that is edited
 * while a bot pages the board: the ticket would end up above the saved cursor
 * and no later page could return it. A stable key keeps the scan complete.
 */
function encodeTicketListCursor(row: { createdAt: Date; id: string }): string {
  return Buffer.from(`${row.createdAt.toISOString()}|${row.id}`, "utf8").toString("base64url");
}

function decodeTicketListCursor(
  cursor: string,
): { createdAt: Date; id: string } | { error: string } {
  let raw: string;
  try {
    raw = Buffer.from(cursor, "base64url").toString("utf8");
  } catch {
    return { error: "cursor is invalid." };
  }
  const split = raw.indexOf("|");
  if (split <= 0) return { error: "cursor is invalid." };
  const createdAt = new Date(raw.slice(0, split));
  const id = raw.slice(split + 1);
  if (Number.isNaN(createdAt.getTime()) || !id) return { error: "cursor is invalid." };
  return { createdAt, id };
}

function truncateDescription(value: string | null | undefined) {
  if (!value || value.length <= LIST_DESCRIPTION_CHARS) return value;
  return `${value.slice(0, LIST_DESCRIPTION_CHARS - 1)}…`;
}

/**
 * List one page of the space's tickets, newest first, with a cursor for the next
 * page. Each ticket carries its own `updatedAt`, so callers can sort by recency.
 */
export async function listBoardTickets(
  deps: TicketToolDeps,
  input: {
    spaceId: string;
    status?: string;
    assigneeBotId?: string;
    cursor?: string;
  },
) {
  let status: TicketStatus | undefined;
  if (input.status !== undefined) {
    status = coerceInputStatus(input.status);
    if (!status) return { error: STATUS_ERROR };
  }
  const cursor = input.cursor?.trim();
  let pageCursor: { createdAt: Date; id: string } | undefined;
  if (cursor) {
    const decoded = decodeTicketListCursor(cursor);
    if ("error" in decoded) return decoded;
    pageCursor = decoded;
  }
  const board = await ensureBoard(deps.prisma, input.spaceId);
  const rows = await deps.prisma.ticket.findMany({
    where: {
      spaceId: input.spaceId,
      boardId: board.id,
      // Closed tickets are history; they only show up when asked for by status.
      ...(status ? { status } : { status: { not: "closed" } }),
      ...(input.assigneeBotId ? { assigneeBotId: input.assigneeBotId } : {}),
      // A stable order: an edit changes `updatedAt`, not the page key, so no
      // ticket can slip past the cursor of a scan that is already in flight.
      ...(pageCursor
        ? {
            OR: [
              { createdAt: { lt: pageCursor.createdAt } },
              { createdAt: pageCursor.createdAt, id: { lt: pageCursor.id } },
            ],
          }
        : {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: LIST_TICKETS_LIMIT + 1,
  });
  const page = rows.slice(0, LIST_TICKETS_LIMIT);
  const next = rows.length > LIST_TICKETS_LIMIT ? page.at(-1) : undefined;
  // A list is for scanning; ticket_get returns the full description.
  return {
    tickets: page.map((row) => {
      const dto = toTicketDto(row, board.ticketPrefix);
      return { ...dto, description: truncateDescription(dto.description) };
    }),
    ...(next ? { nextCursor: encodeTicketListCursor(next) } : {}),
  };
}

/** Read one ticket with its comments, by database id or by reference such as `RAK-42`. */
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

/**
 * Create a ticket in `todo`, allocate its number, and wake the owner. The owner
 * defaults to the calling bot and must be a bot of the same space.
 */
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
        ...ticketEditorStamp(input.botId, ownerBotId),
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

/** Move a ticket to another status; a completed status also stamps `completedAt`. */
export async function moveTicket(
  deps: TicketToolDeps,
  input: { spaceId: string; botId: string; id: string; status: string },
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
      ...ticketEditorStamp(input.botId, existing.assigneeBotId),
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

/** Change a ticket's title, description or priority. At least one field is required. */
export async function updateTicket(
  deps: TicketToolDeps,
  input: {
    spaceId: string;
    botId: string;
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

  const data: {
    title?: string;
    description?: string | null;
    priority?: string;
    updatedByBotId: string | null;
    externalUpdatedAt?: Date;
  } = { ...ticketEditorStamp(input.botId, existing.assigneeBotId) };
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

/** Close a ticket and add the optional closing comment in the same transaction. */
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
      data: {
        status: "closed",
        completedAt: existing.completedAt ?? new Date(),
        ...ticketEditorStamp(input.botId, existing.assigneeBotId),
      },
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

/** Add a comment and record the ticket as changed by the commenting bot. */
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
    await tx.ticket.update({
      where: { id: ticket.id },
      data: {
        updatedAt: new Date(),
        ...ticketEditorStamp(input.botId, ticket.assigneeBotId),
      },
    });
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

/** Hand a ticket to another bot of the same space and wake the new owner. */
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
    data: {
      assigneeBotId: input.ownerBotId,
      assigneeUserId: null,
      ...ticketEditorStamp(input.botId, input.ownerBotId),
    },
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
