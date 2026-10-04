import type {
  Board,
  Ticket,
  TicketComment,
  TicketCriterion,
  TicketEvent,
  TicketEventType,
  TicketPriority,
  TicketStatus,
} from "@rakazo/contracts";
import {
  parseCriteria,
  parseTicketRef,
  reservedTicketNumber,
  TICKET_EVENT_TYPES,
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
  acceptanceCriteria?: unknown;
  statusChangedAt?: Date | null;
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

/** Map a board row to its API shape, with ISO timestamps. */
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

/** Unknown or legacy status strings fall back to `todo`, so an old row still renders. */
export function coerceTicketStatus(value: string): TicketStatus {
  const parsed = TicketStatusSchema.safeParse(value);
  return parsed.success ? parsed.data : "todo";
}

/** Legacy free-text priorities fall back to `normal` so old rows keep rendering. */
export function coerceTicketPriority(value: string | null | undefined): TicketPriority {
  const parsed = TicketPrioritySchema.safeParse(typeof value === "string" ? value.trim() : value);
  return parsed.success ? parsed.data : "normal";
}

/**
 * Map a ticket row to its API shape: the human reference, the coerced status and
 * priority, and ISO timestamps.
 */
export function toTicketDto(row: TicketRow, ticketPrefix: string): Ticket {
  return {
    id: row.id,
    boardId: row.boardId,
    spaceId: row.spaceId,
    number: row.number,
    ref: ticketRef(ticketPrefix, row.number),
    title: row.title,
    description: row.description,
    acceptanceCriteria: parseCriteria(row.acceptanceCriteria),
    statusChangedAt: (row.statusChangedAt ?? row.createdAt).toISOString(),
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

/** Map a comment row to its API shape, with ISO timestamps. */
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

/** The ticket fields whose changes are worth a history entry. */
export type TicketSnapshot = {
  title: string;
  description: string | null;
  status: string;
  priority: string | null;
  assigneeBotId: string | null;
  acceptanceCriteria?: unknown;
};

export type TicketEventDraft = { type: TicketEventType; data: Record<string, unknown> };

/** Extra column to set when a status actually changes, so column aging stays accurate. */
export function statusChangeData(
  previousStatus: string,
  nextStatus: string,
  now = new Date(),
): { statusChangedAt?: Date } {
  return previousStatus === nextStatus ? {} : { statusChangedAt: now };
}

/** Diff two ticket snapshots into history entries; unchanged fields produce nothing. */
export function ticketChangeEvents(
  before: TicketSnapshot,
  after: TicketSnapshot,
): TicketEventDraft[] {
  const events: TicketEventDraft[] = [];
  if (before.title !== after.title) {
    events.push({ type: "title_changed", data: { from: before.title, to: after.title } });
  }
  if ((before.description ?? "") !== (after.description ?? "")) {
    events.push({ type: "description_changed", data: {} });
  }
  if (before.status !== after.status) {
    events.push({ type: "status_changed", data: { from: before.status, to: after.status } });
  }
  if (before.assigneeBotId !== after.assigneeBotId) {
    events.push({
      type: "assignee_changed",
      data: { from: before.assigneeBotId, to: after.assigneeBotId },
    });
  }
  if ((before.priority ?? "normal") !== (after.priority ?? "normal")) {
    events.push({
      type: "priority_changed",
      data: { from: before.priority ?? "normal", to: after.priority ?? "normal" },
    });
  }
  events.push(
    ...criteriaChangeEvents(
      parseCriteria(before.acceptanceCriteria),
      parseCriteria(after.acceptanceCriteria),
    ),
  );
  return events;
}

function criteriaChangeEvents(
  before: readonly TicketCriterion[],
  after: readonly TicketCriterion[],
): TicketEventDraft[] {
  const beforeByText = new Map(before.map((item) => [item.text, item.done]));
  const afterTexts = new Set(after.map((item) => item.text));
  const events: TicketEventDraft[] = [];
  let structural = before.length !== after.length;
  for (const item of after) {
    const previous = beforeByText.get(item.text);
    if (previous === undefined) {
      structural = true;
    } else if (previous !== item.done) {
      events.push({
        type: item.done ? "criterion_checked" : "criterion_unchecked",
        data: { text: item.text },
      });
    }
  }
  if (before.some((item) => !afterTexts.has(item.text))) structural = true;
  if (!structural && before.some((item, index) => item.text !== after[index]?.text)) {
    structural = true;
  }
  if (structural) {
    events.unshift({ type: "criteria_changed", data: { count: after.length } });
  }
  return events;
}

export type TicketEventActor = { botId?: string | null; userId?: string | null };

/** Append history entries for one ticket. Safe to call with an empty list. */
export async function recordTicketEvents(
  prisma: Pick<PrismaClient, "ticketEvent">,
  input: {
    ticketId: string;
    spaceId: string;
    actor: TicketEventActor;
    events: readonly TicketEventDraft[];
  },
): Promise<void> {
  if (input.events.length === 0) return;
  await prisma.ticketEvent.createMany({
    data: input.events.map((event) => ({
      ticketId: input.ticketId,
      spaceId: input.spaceId,
      actorBotId: input.actor.botId ?? null,
      actorUserId: input.actor.userId ?? null,
      type: event.type,
      data: event.data as Prisma.InputJsonValue,
    })),
  });
}

/** History for a ticket, newest first, scoped to the space. */
export async function listTicketEvents(
  prisma: Pick<PrismaClient, "ticketEvent">,
  spaceId: string,
  ticketId: string,
) {
  return prisma.ticketEvent.findMany({
    where: { ticketId, spaceId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 200,
  });
}

export function toTicketEventDto(row: {
  id: string;
  ticketId: string;
  type: string;
  actorBotId: string | null;
  actorUserId: string | null;
  data: unknown;
  createdAt: Date;
}): TicketEvent {
  const type = (TICKET_EVENT_TYPES as readonly string[]).includes(row.type)
    ? (row.type as TicketEventType)
    : "override";
  const data =
    row.data && typeof row.data === "object" && !Array.isArray(row.data)
      ? (row.data as Record<string, unknown>)
      : {};
  return {
    id: row.id,
    ticketId: row.ticketId,
    type,
    actorBotId: row.actorBotId,
    actorUserId: row.actorUserId,
    data,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Persist the justification a rule asked for: as a ticket comment (so the owner and
 * later readers see it) and, for an override of an open checklist, as a history entry.
 */
export async function recordTransitionReason(
  prisma: Pick<PrismaClient, "ticketComment" | "ticketEvent">,
  input: {
    ticketId: string;
    spaceId: string;
    actor: TicketEventActor;
    to: string;
    reason: string | null | undefined;
    criteria: readonly TicketCriterion[];
  },
): Promise<void> {
  const reason = input.reason?.trim();
  if (!reason) return;
  const open = input.criteria.filter((item) => !item.done).length;
  const overrides = (input.to === "review" || input.to === "done") && open > 0;
  if (input.to !== "blocked" && input.to !== "closed" && !overrides) return;
  await prisma.ticketComment.create({
    data: {
      ticketId: input.ticketId,
      spaceId: input.spaceId,
      authorBotId: input.actor.botId ?? null,
      authorUserId: input.actor.userId ?? null,
      body: overrides
        ? `Moved to ${input.to} with ${open} open criteria: ${reason}`
        : input.to === "closed"
          ? `Won't do: ${reason}`
          : `Blocked: ${reason}`,
    },
  });
  if (overrides) {
    await recordTicketEvents(prisma, {
      ticketId: input.ticketId,
      spaceId: input.spaceId,
      actor: input.actor,
      events: [{ type: "override", data: { to: input.to, openCriteria: open, reason } }],
    });
  }
}
