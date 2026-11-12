import { isRunWorking } from "@rakazo/core";

/**
 * Whether a one-to-one chat's thread has a run at work: the status the chat shows, or any of
 * its own active runs for that bot. `runs` is undefined while only a saved copy of the chat is
 * on screen, whose runs may be stale. Writing the reply is still work, so it counts too.
 */
export function threadRunWorking(
  status: string | undefined,
  runs: readonly { status: string; botId?: string }[] | undefined,
  botId: string | undefined,
): boolean {
  if (isRunWorking(status)) return true;
  return (runs ?? []).some(
    (run) => isRunWorking(run.status) && (!run.botId || !botId || run.botId === botId),
  );
}
