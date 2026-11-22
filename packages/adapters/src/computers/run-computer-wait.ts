import { pollUntil } from "@rakazo/core";

/** How long a run waits for its bot's computer while other work holds it. */
export const RUN_COMPUTER_WAIT_MS = 2 * 60_000;

/**
 * The bot's computer stayed busy for the whole wait. Only the tool call that needed it fails;
 * the run goes on, and its next computer tool waits again.
 */
export class ComputerWaitTimedOutError extends Error {
  constructor() {
    super("The computer is still busy with earlier work. Try again in a moment.");
    this.name = "ComputerWaitTimedOutError";
  }
}

/**
 * Start a run's computer, retrying in place while it is busy: a boot by another caller, or a
 * boot or reclaim held by another live run of the same computer. Without this a busy start failed
 * the whole run, which the executor retried from the top, replaying the model turn up to the same
 * tool call. A computer still busy when the wait runs out ends only this tool call with
 * `ComputerWaitTimedOutError`.
 */
export async function startComputerWaitingOutBusy<T>(
  start: () => Promise<T>,
  isBusy: (error: unknown) => boolean,
  signal: AbortSignal,
  timeoutMs = RUN_COMPUTER_WAIT_MS,
): Promise<T> {
  const outcome = await pollUntil(
    async () => {
      try {
        return { computer: await start() };
      } catch (error) {
        if (!isBusy(error)) throw error;
        return undefined;
      }
    },
    {
      intervalMs: (attempt) => Math.min(1_000 * 2 ** Math.min(attempt - 1, 4), 10_000),
      timeoutMs,
      signal,
      onTimeout: () => {
        throw new ComputerWaitTimedOutError();
      },
    },
  );
  return outcome.computer;
}
