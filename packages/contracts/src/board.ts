import * as z from "zod";
import { Id } from "./ids.js";

export const TICKET_STATUSES = ["todo", "doing", "review", "blocked", "done", "closed"] as const;
export const TicketStatusSchema = z.enum(TICKET_STATUSES);
export type TicketStatus = z.infer<typeof TicketStatusSchema>;

/** Statuses a bot is expected to act on without any further prompt. */
export const ACTIONABLE_TICKET_STATUSES = ["todo", "doing"] as const;

/** `done` is finished-but-open for review; `closed` is terminal, so both stamp completion. */
export function isTicketCompletedStatus(status: TicketStatus): boolean {
  return status === "done" || status === "closed";
}

export const TICKET_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export const TicketPrioritySchema = z.enum(TICKET_PRIORITIES);
export type TicketPriority = z.infer<typeof TicketPrioritySchema>;
export const DEFAULT_TICKET_PRIORITY: TicketPriority = "normal";

export const TICKET_TITLE_MAX_LENGTH = 200;
export const TICKET_DESCRIPTION_MAX_LENGTH = 20_000;
export const TICKET_CRITERIA_MAX_ITEMS = 50;
export const TICKET_CRITERION_MAX_LENGTH = 500;
export const TICKET_PREFIX_MAX_LENGTH = 12;
export const TICKET_COMMENT_MAX_LENGTH = 10_000;

export const TicketCriterionSchema = z.object({
  text: z.string().trim().min(1).max(TICKET_CRITERION_MAX_LENGTH),
  done: z.boolean(),
});
export type TicketCriterion = z.infer<typeof TicketCriterionSchema>;

/** Ordered acceptance-criteria checklist as stored and returned. */
export const AcceptanceCriteriaSchema = z
  .array(TicketCriterionSchema)
  .max(TICKET_CRITERIA_MAX_ITEMS);

/**
 * Criteria as accepted from a client or bot: a plain string is an unchecked item
 * (or keeps its checked state when the same text already exists on the ticket).
 */
export const AcceptanceCriteriaInputSchema = z
  .array(
    z.union([z.string().trim().min(1).max(TICKET_CRITERION_MAX_LENGTH), TicketCriterionSchema]),
  )
  .max(TICKET_CRITERIA_MAX_ITEMS);
export type AcceptanceCriteriaInput = z.infer<typeof AcceptanceCriteriaInputSchema>;

/** Resolve incoming criteria against the ticket's current ones, preserving checked state by text. */
export function resolveCriteria(
  input: AcceptanceCriteriaInput,
  existing: readonly TicketCriterion[],
): TicketCriterion[] {
  const doneByText = new Map(existing.map((item) => [item.text, item.done]));
  return input.map((item) =>
    typeof item === "string"
      ? { text: item, done: doneByText.get(item) ?? false }
      : { text: item.text, done: item.done },
  );
}

/** Tolerant reader for stored JSON: accepts legacy plain strings and drops malformed items. */
export function parseCriteria(value: unknown): TicketCriterion[] {
  if (!Array.isArray(value)) return [];
  const items: TicketCriterion[] = [];
  for (const entry of value) {
    if (typeof entry === "string" && entry.trim()) {
      items.push({ text: entry.trim(), done: false });
    } else if (entry && typeof entry === "object") {
      const { text, done } = entry as { text?: unknown; done?: unknown };
      if (typeof text === "string" && text.trim())
        items.push({ text: text.trim(), done: done === true });
    }
  }
  return items;
}

export const TICKET_WIP_LIMIT = 3;

export type TicketTransitionCheck = {
  from: TicketStatus;
  to: TicketStatus;
  criteria: readonly TicketCriterion[];
  hasAssignee: boolean;
  /** Free-text justification: a blocker description, or an override of an open checklist. */
  reason?: string | null;
};

/**
 * Board rules for moving a ticket between columns. Returns an error message, or
 * null when the move is allowed. Backward moves and reopening are always free.
 */
export function checkTicketTransition(input: TicketTransitionCheck): string | null {
  if (input.from === input.to) return null;
  const reason = input.reason?.trim() ?? "";
  if (input.to === "doing" && !input.hasAssignee) {
    return "Assign an owner before starting work on this ticket.";
  }
  if (input.to === "blocked" && !reason) {
    return "Say what the ticket is blocked on (a reason is required to move it to blocked).";
  }
  if (input.to === "closed" && !reason) {
    return "Say why this ticket will not be done (a reason is required for won't do).";
  }
  if (input.to === "review" || input.to === "done") {
    const open = input.criteria.filter((item) => !item.done).length;
    if (open > 0 && !reason) {
      return `${open} acceptance criteri${open === 1 ? "on is" : "a are"} not checked yet. Check them off, or give a reason to override.`;
    }
  }
  return null;
}

export const TICKET_EVENT_TYPES = [
  "created",
  "status_changed",
  "assignee_changed",
  "priority_changed",
  "title_changed",
  "description_changed",
  "criteria_changed",
  "criterion_checked",
  "criterion_unchecked",
  "commented",
  "override",
] as const;
export const TicketEventTypeSchema = z.enum(TICKET_EVENT_TYPES);
export type TicketEventType = z.infer<typeof TicketEventTypeSchema>;

export const TicketEventSchema = z.object({
  id: Id,
  ticketId: Id,
  type: TicketEventTypeSchema,
  actorBotId: Id.nullable(),
  actorUserId: Id.nullable(),
  /** Small JSON payload, e.g. `{ from, to }` for status changes or `{ text }` for a criterion. */
  data: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
});
export type TicketEvent = z.infer<typeof TicketEventSchema>;

const TicketPrefixSchema = z
  .string()
  .trim()
  .min(1)
  .max(TICKET_PREFIX_MAX_LENGTH)
  .regex(
    /^[A-Za-z][A-Za-z0-9]*$/,
    "Prefix must start with a letter and contain only letters and digits",
  );

/** Render a human-readable ticket reference such as `RAK-42`. */
export function ticketRef(prefix: string, number: number): string {
  return `${prefix}-${number}`;
}

/** Parse `RAK-42` (case-insensitive prefix) into its parts, or `null` when malformed. */
export function parseTicketRef(
  value: string,
  expectedPrefix?: string,
): { prefix: string; number: number } | null {
  const match = /^([A-Za-z][A-Za-z0-9]*)-([1-9][0-9]*)$/.exec(value.trim());
  if (!match) return null;
  const [, rawPrefix, rawNumber] = match;
  if (!rawPrefix || !rawNumber) return null;
  const prefix = rawPrefix.toUpperCase();
  if (expectedPrefix !== undefined && prefix !== expectedPrefix.trim().toUpperCase()) return null;
  return { prefix, number: Number(rawNumber) };
}

/**
 * `board.nextNumber` holds the number the next ticket should get. A race-safe
 * allocation atomically increments it and returns the post-increment value, so
 * the reserved number is one less than what the database returned.
 */
export function reservedTicketNumber(incrementedNextNumber: number): number {
  return incrementedNextNumber - 1;
}

export const BoardSchema = z.object({
  id: Id,
  spaceId: Id,
  name: z.string(),
  ticketPrefix: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Board = z.infer<typeof BoardSchema>;

export const RenameBoardInput = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    ticketPrefix: TicketPrefixSchema.optional(),
  })
  .refine((value) => value.name !== undefined || value.ticketPrefix !== undefined, {
    message: "Provide a name or ticketPrefix",
  });
export type RenameBoardInput = z.infer<typeof RenameBoardInput>;

export const TicketCommentSchema = z.object({
  id: Id,
  ticketId: Id,
  body: z.string(),
  authorBotId: Id.nullable(),
  authorUserId: Id.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type TicketComment = z.infer<typeof TicketCommentSchema>;

export const TicketSchema = z.object({
  id: Id,
  boardId: Id,
  spaceId: Id,
  number: z.number().int().positive(),
  ref: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  acceptanceCriteria: AcceptanceCriteriaSchema,
  statusChangedAt: z.string(),
  status: TicketStatusSchema,
  priority: TicketPrioritySchema,
  assigneeBotId: Id.nullable(),
  createdByBotId: Id.nullable(),
  createdByUserId: Id.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  completedAt: z.string().nullable(),
});
export type Ticket = z.infer<typeof TicketSchema>;

export const ListTicketsInput = z.object({
  boardId: Id.optional(),
  status: TicketStatusSchema.optional(),
  assigneeBotId: Id.optional(),
  q: z.string().trim().max(200).optional(),
});
export type ListTicketsInput = z.infer<typeof ListTicketsInput>;

/** A ticket-trigger run idle for this long no longer reads as "working" (stuck-run guard). */
export const TICKET_RUN_ACTIVITY_STALE_MS = 20 * 60 * 1000;

/**
 * The board's tickets plus the owner bots currently running a ticket wake, so the
 * card can show a work indicator without a second request.
 */
export const BotTicketIssueSchema = z.object({
  botId: Id,
  message: z.string(),
  at: z.string(),
});
export type BotTicketIssue = z.infer<typeof BotTicketIssueSchema>;

export const ListTicketsOutput = z.object({
  tickets: z.array(TicketSchema),
  /** Tickets an owner bot is working on right now (not merely tickets of a busy bot). */
  workingTicketIds: z.array(Id),
  /** Bots whose latest ticket wake failed or keeps failing to start. */
  botIssues: z.array(BotTicketIssueSchema),
});
export type ListTicketsOutput = z.infer<typeof ListTicketsOutput>;

export const GetTicketInput = z
  .object({
    id: Id.optional(),
    ref: z.string().trim().min(1).max(120).optional(),
  })
  .refine((value) => Boolean(value.id) !== Boolean(value.ref), {
    message: "Provide exactly one of id or ref",
  });
export type GetTicketInput = z.infer<typeof GetTicketInput>;

export const CreateTicketInput = z.object({
  boardId: Id.optional(),
  title: z.string().trim().min(1).max(TICKET_TITLE_MAX_LENGTH),
  description: z.string().max(TICKET_DESCRIPTION_MAX_LENGTH).optional(),
  acceptanceCriteria: AcceptanceCriteriaInputSchema.optional(),
  priority: TicketPrioritySchema.default(DEFAULT_TICKET_PRIORITY),
  assigneeBotId: Id,
});
export type CreateTicketInput = z.infer<typeof CreateTicketInput>;

export const UpdateTicketInput = z.object({
  id: Id,
  title: z.string().trim().min(1).max(TICKET_TITLE_MAX_LENGTH).optional(),
  description: z.string().max(TICKET_DESCRIPTION_MAX_LENGTH).nullable().optional(),
  acceptanceCriteria: AcceptanceCriteriaInputSchema.optional(),
  priority: TicketPrioritySchema.nullable().optional(),
  status: TicketStatusSchema.optional(),
  /** Needed when the move requires a justification (blocked, or done with open criteria). */
  reason: z.string().trim().max(TICKET_COMMENT_MAX_LENGTH).optional(),
  assigneeBotId: Id.optional(),
});
export type UpdateTicketInput = z.infer<typeof UpdateTicketInput>;

export const MoveTicketInput = z.object({
  id: Id,
  status: TicketStatusSchema,
  reason: z.string().trim().max(TICKET_COMMENT_MAX_LENGTH).optional(),
});
export type MoveTicketInput = z.infer<typeof MoveTicketInput>;

export const CommentTicketInput = z.object({
  ticketId: Id,
  body: z.string().trim().min(1).max(TICKET_COMMENT_MAX_LENGTH),
});
export type CommentTicketInput = z.infer<typeof CommentTicketInput>;

/**
 * A lightweight "something on this board changed" signal. Clients refetch the
 * list on every frame; no diffing and no persisted cursor are needed.
 */
export const BoardEventSchema = z.object({
  spaceId: Id,
  boardId: Id.optional(),
  ticketId: Id.optional(),
  createdAt: z.string(),
});
export type BoardEvent = z.infer<typeof BoardEventSchema>;
