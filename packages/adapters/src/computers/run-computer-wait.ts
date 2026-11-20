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
