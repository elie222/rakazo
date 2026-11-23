import type { Bot, Routine, ThreadSnapshot } from "@rakazo/contracts";
import { isActive } from "@rakazo/core";
import { bestEffort } from "@rakazo/logging/best-effort";
import type { ComponentProps, RefObject } from "react";
import { useRef } from "react";
import type { SpaceQueries } from "../../lib/query/query";
import { queryClient } from "../../lib/query/query";
import type { createSpaceRpc } from "../../lib/query/rpc";
import { errorText } from "../../lib/query/user-error";
import { routineNeedsOneShotArm } from "../../lib/routines/routine-draft";
import type { RoutineList } from "../routines/RoutineList";
import type { ThreadState } from "./chat/use-thread-state";

/** The open bot's routine list: what it shows while the bot's routines load, and its switches. */
export function useRoutineList({
  rpc,
  queries,
  thread,
  active,
  inGroup,
  activeBotId,
  refreshThread,
  startRoutine,
  stopRun,
  setSendError,
}: {
  rpc: ReturnType<typeof createSpaceRpc>;
  queries: SpaceQueries;
  thread: ThreadState;
  active: Bot | undefined;
  inGroup: boolean;
  activeBotId: RefObject<string | undefined>;
  refreshThread: (botId: string) => Promise<ThreadSnapshot>;
  startRoutine: (routine?: Routine) => void;
  stopRun: () => Promise<unknown>;
  setSendError: (error: string | null) => void;
}): Omit<ComponentProps<typeof RoutineList>, "preview"> {
  // Until this visit's read lands, a bot shows the routines and skills it had last time.
  const cachedRoutines =
    inGroup || !active || thread.routinesBotId === active.id
      ? undefined
      : queryClient.getQueryData(queries.routines.list.queryKey({ input: { botId: active.id } }));
  // The on/off choice still to send for each routine whose switch was just pressed.
  const routineToggles = useRef(new Map<string, boolean>());
  const { snapshot } = thread;
  return {
    routines:
      inGroup || !active
        ? []
        : thread.routinesBotId === active.id
          ? thread.routines
          : (cachedRoutines ?? []),
    // A bot opened for the first time has no routines to show yet, which is not the same as none.
    loaded:
      !active || inGroup || thread.routinesBotId === active.id || cachedRoutines !== undefined,
    runningRoutineId:
      snapshot?.run && isActive(snapshot.run.status)
        ? (snapshot.run.routineId ?? undefined)
        : undefined,
    onCreate: () => startRoutine(),
    onEdit: startRoutine,
    onStop: () => void stopRun(),
    onToggle: (routine, on) => {
      // A one-shot that never ran needs a run time, which only its editor can take.
      if (on && routineNeedsOneShotArm(routine, routine.crons)) {
        startRoutine(routine);
        return;
      }
      thread.setRoutines((current) =>
        current.map((item) => (item.id === routine.id ? { ...item, active: on } : item)),
      );
      // One update per routine at a time, so quick presses cannot race; the last one wins.
      const queued = routineToggles.current.get(routine.id);
      routineToggles.current.set(routine.id, on);
      if (queued !== undefined) return;
      void (async () => {
        let sent: boolean | undefined;
        try {
          while (routineToggles.current.get(routine.id) !== sent) {
            sent = routineToggles.current.get(routine.id);
            await rpc.routines.update({ routineId: routine.id, active: sent });
          }
        } catch (error) {
          setSendError(errorText(error));
        } finally {
          routineToggles.current.delete(routine.id);
          // Another bot opened since must not have its own refresh superseded.
          if (activeBotId.current === routine.botId)
            void bestEffort("refresh thread after routine toggle", refreshThread(routine.botId));
        }
      })();
    },
  };
}
