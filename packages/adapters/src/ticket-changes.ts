import type { JobPublisher } from "@rakazo/adapter-kit";
import { ticketsCheckJob } from "@rakazo/adapter-kit";
import type { BoardEvents } from "@rakazo/db";

export type TicketChange = {
  spaceId: string;
  boardId: string;
  ticketId: string;
  assigneeBotId: string | null;
  /** The bot that made the change, when a bot did; humans leave this null. */
  actorBotId?: string | null;
  /** A create or reassignment may need to wake the new owner. */
  wakeAssignee: boolean;
};

export type TicketChangeNotifier = (change: TicketChange) => Promise<void>;

/**
 * The single seam every ticket mutation funnels through: it publishes the
 * board-change signal and wakes the owner when someone else created or handed
 * over a ticket. Self-actions never wake the actor.
 */
export function createTicketChangeNotifier(deps: {
  boardEvents: BoardEvents;
  jobs: JobPublisher;
}): TicketChangeNotifier {
  return async (change) => {
    await deps.boardEvents
      .notify(change.spaceId, { boardId: change.boardId, ticketId: change.ticketId })
      .catch(() => undefined);
    const assignee = change.assigneeBotId;
    if (!change.wakeAssignee || !assignee) return;
    if (change.actorBotId && change.actorBotId === assignee) return;
    await deps.jobs.enqueue(ticketsCheckJob(assignee)).catch(() => undefined);
  };
}
