import type { JobPublisher } from "@rakazo/adapter-kit";
import type { LabFeature } from "@rakazo/contracts";
import type { BoardEvents, PrismaClient, ThreadEvents } from "@rakazo/db";
import { bestEffort } from "@rakazo/logging";
import { wakeTicketAssignee } from "./ticket-wake.js";

export type TicketChange = {
  spaceId: string;
  boardId: string;
  ticketId: string;
  assigneeBotId: string | null;
  wakeAssignee: boolean;
};
export type TicketChangeNotifier = (change: TicketChange) => Promise<void>;

export function createTicketChangeNotifier(deps: {
  boardEvents: BoardEvents;
  events: Pick<ThreadEvents, "publishSpaceChange">;
  prisma: PrismaClient;
  jobs: JobPublisher;
  deploymentLabs?: readonly LabFeature[];
}): TicketChangeNotifier {
  return async (change) => {
    await deps.events.publishSpaceChange?.(change.spaceId, "board");
    // compat-shim(after v0.16.0): already-open web clients still use the dedicated board endpoint.
    await bestEffort(
      "legacy board signal",
      deps.boardEvents.notify(change.spaceId, {
        boardId: change.boardId,
        ticketId: change.ticketId,
      }),
    );
    if (change.wakeAssignee && change.assigneeBotId) {
      await wakeTicketAssignee(deps, {
        spaceId: change.spaceId,
        ticketId: change.ticketId,
        botId: change.assigneeBotId,
      });
    }
  };
}
