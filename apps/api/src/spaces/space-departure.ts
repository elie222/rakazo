import type { JobPublisher, SandboxProvider } from "@rakazo/adapter-kit";
import type { MeetingCalendarService, MeetingService } from "@rakazo/adapters";
import { expireComputerControl, stopCancelledGroupRuns, wakeRun } from "@rakazo/adapters";
import type { PrismaClient, SpaceDeparture, ThreadEvents } from "@rakazo/db";
import { bestEffort, getLogger } from "@rakazo/logging";

/**
 * After someone leaves a Space, is removed, or deletes their account: tell clients their runs
 * were cancelled, stop those runs' work, release the screens they held, and start the follow-ups
 * that waited behind them. The departure is committed, so each failure is logged rather than
 * reported; expired leases and the job reconciler catch up.
 */
export async function afterSpaceDeparture(
  deps: {
    prisma: PrismaClient;
    sandbox: SandboxProvider;
    jobs: JobPublisher;
    events: ThreadEvents;
    meetings?: Pick<MeetingService, "stopForDepartedMember">;
    meetingCalendar?: Pick<MeetingCalendarService, "disconnectOwner">;
  },
  actor: { spaceId: string; userId: string },
  departure: SpaceDeparture,
  departedUserId = actor.userId,
): Promise<void> {
  const calendar =
    deps.meetingCalendar &&
    bestEffort(
      "disconnect meeting calendar after Space departure",
      deps.meetingCalendar.disconnectOwner({ spaceId: actor.spaceId, userId: departedUserId }),
    );
  const meetings =
    deps.meetings &&
    bestEffort(
      "stop meetings after Space departure",
      deps.meetings.stopForDepartedMember({ spaceId: actor.spaceId, userId: departedUserId }),
    );
  await Promise.all(departure.events.map(({ threadId, seq }) => deps.events.notify(threadId, seq)));
  // Their routines pass to the owner, paused.
  await deps.events.publishSpaceChange?.(actor.spaceId, "routines");
  await stopCancelledGroupRuns(deps, actor, departure).catch((error) => {
    getLogger().error("space departure run teardown", error);
  });
  await Promise.all(
    departure.heldControls.map(({ computerId, leaseId }) =>
      expireComputerControl(deps, computerId, leaseId).catch((error) => {
        getLogger().error("space departure control release", error);
      }),
    ),
  );
  await Promise.all(departure.continuationRunIds.map((runId) => wakeRun(deps.jobs, runId)));
  await Promise.all([calendar, meetings]);
}
