import type { TicketPriority, TicketStatus } from "@rakazo/contracts";

/** Wake a bot when the oldest actionable ticket has sat untouched this long. */
export const TICKET_REMINDER_MS = 4 * 60 * 60 * 1000;
/** At most one ticket wake per bot in this window, however it was triggered. */
export const TICKET_WAKE_DEBOUNCE_MS = 10 * 60 * 1000;
/** The board is swept in the background on this interval. */
export const TICKET_CHECK_INTERVAL_MS = 30 * 60 * 1000;

export type TicketWakeTrigger = "periodic" | "event";

export type TicketWakeTicket = {
  id: string;
  ref: string;
  title: string;
  status: TicketStatus;
  priority: TicketPriority;
  updatedAt: Date;
  lastComment: string | null;
};

export type TicketWakeReason = "changed" | "reminder" | "assigned";

export type TicketWakeDecision =
  | { wake: true; reason: TicketWakeReason }
  | { wake: false; reason: "no-tickets" | "active-run" | "unchanged" | "debounced" };

export type TicketWakeDecisionInput = {
  now: Date;
  trigger: TicketWakeTrigger;
  /** Actionable tickets assigned to the bot, any order. */
  tickets: readonly { updatedAt: Date }[];
  lastCheckAt: Date | null;
  lastWakeAt: Date | null;
  hasActiveRun: boolean;
  reminderMs?: number;
  debounceMs?: number;
};

/**
 * Pure scheduling decision for waking a bot to work its tickets. The caller
 * supplies persisted timestamps and the current run state; this function only
 * decides, so every branch is testable without a database.
 */
export function decideTicketWake(input: TicketWakeDecisionInput): TicketWakeDecision {
  if (input.tickets.length === 0) return { wake: false, reason: "no-tickets" };
  if (input.hasActiveRun) return { wake: false, reason: "active-run" };

  const debounceMs = input.debounceMs ?? TICKET_WAKE_DEBOUNCE_MS;
  if (input.lastWakeAt && input.now.getTime() - input.lastWakeAt.getTime() < debounceMs) {
    return { wake: false, reason: "debounced" };
  }

  if (input.trigger === "event") return { wake: true, reason: "assigned" };

  const reminderMs = input.reminderMs ?? TICKET_REMINDER_MS;
  const lastCheckAt = input.lastCheckAt;
  const changed = lastCheckAt
    ? input.tickets.some((ticket) => ticket.updatedAt.getTime() > lastCheckAt.getTime())
    : true;
  if (changed) return { wake: true, reason: "changed" };

  const oldest = input.tickets.reduce(
    (earliest, ticket) => (ticket.updatedAt < earliest ? ticket.updatedAt : earliest),
    input.tickets[0]!.updatedAt,
  );
  const stale = input.now.getTime() - oldest.getTime() >= reminderMs;
  const remindedRecently =
    input.lastWakeAt !== null && input.now.getTime() - input.lastWakeAt.getTime() < reminderMs;
  if (stale && !remindedRecently) return { wake: true, reason: "reminder" };

  return { wake: false, reason: "unchanged" };
}

const MAX_PROMPT_TICKETS = 20;
const MAX_PROMPT_FIELD_CHARS = 300;

export type TicketWakePromptInput = {
  botName: string;
  tickets: readonly TicketWakeTicket[];
  reason: TicketWakeReason;
};

/** Render the standing instruction a ticket check wakes the bot with. */
export function renderTicketWakePrompt(input: TicketWakePromptInput): string {
  const name = input.botName.trim() || "bot";
  const reasonCue =
    input.reason === "reminder"
      ? "Some of your tickets have been idle for a while."
      : input.reason === "assigned"
        ? "A ticket was created for you or handed to you."
        : "Your tickets changed since the last check.";
  const lines = input.tickets.slice(0, MAX_PROMPT_TICKETS).map((ticket) => {
    const parts = [
      `- ${escapePromptData(ticket.ref)} [${escapePromptData(ticket.status)}] ${escapePromptData(
        truncate(ticket.title),
      )}`,
      `  priority: ${escapePromptData(ticket.priority)}`,
    ];
    if (ticket.lastComment) {
      parts.push(`  last comment: ${escapePromptData(truncate(ticket.lastComment))}`);
    }
    return parts.join("\n");
  });
  return [
    `[Ticket check] ${reasonCue} You are ${name}. This is a background reminder, not a message from the user.`,
    "<your_tickets>",
    ...lines,
    "</your_tickets>",
    "Work your actionable tickets now. Keep progress on the ticket with ticket_comment, keep its status current with ticket_move or ticket_close, mark blockers blocked with a comment, and hand off with ticket_assign when another bot should take it. Use the ticket tools; do not only describe what you would do.",
    "Only message the user when a decision or input is genuinely needed. Otherwise stay terse and do the work.",
  ].join("\n");
}

function truncate(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > MAX_PROMPT_FIELD_CHARS
    ? `${trimmed.slice(0, MAX_PROMPT_FIELD_CHARS - 1)}…`
    : trimmed;
}

function escapePromptData(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
