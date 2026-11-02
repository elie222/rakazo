import type { Ticket, TicketStatus } from "@rakazo/contracts";
import { TICKET_STATUSES } from "@rakazo/contracts";

/** The board's columns, in the order the web board shows them. */
export const BOARD_COLUMN_STATUSES = TICKET_STATUSES;

export type BoardSection = { status: TicketStatus; tickets: Ticket[] };

/**
 * Groups the board's tickets by status, keeping the columns in board order and
 * dropping empty ones. Tickets arrive most recently updated first, so a column reads the same
 * way as the web board without another sort.
 */
export function boardSections(tickets: readonly Ticket[]): BoardSection[] {
  return BOARD_COLUMN_STATUSES.map((status) => ({
    status,
    tickets: tickets.filter((ticket) => ticket.status === status),
  })).filter((section) => section.tickets.length > 0);
}

/** A ticket's status as the board names it, matching the web board's wording. */
export function ticketStatusLabel(status: TicketStatus, t: (message: string) => string): string {
  switch (status) {
    case "todo":
      return t("To do");
    case "doing":
      return t("In progress");
    case "review":
      return t("In review");
    case "blocked":
      return t("Blocked");
    case "done":
      return t("Done");
    case "closed":
      return t("Won't do");
  }
}
