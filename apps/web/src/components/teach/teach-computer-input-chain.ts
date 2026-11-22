import { requestDeadline, withAbort } from "@rakazo/core";

const SETTLE_MS = 5_000;
const chains = new Map<string, Promise<void>>();

// One chain per bot so a protected paste follows the click that focused the field.
export function enqueueTeachComputerInput(botId: string, task: () => Promise<void>): Promise<void> {
  const previous = chains.get(botId) ?? Promise.resolve();
  const result = previous.then(task);
  chains.set(
    botId,
    result.then(
      () => undefined,
      () => undefined,
    ),
  );
  return result;
}

// Stop waits for input already queued so the recording keeps its last steps, such as the
// release that ends a drag. A request that never answers holds it back only for a few seconds.
export async function settleTeachComputerInput(botId: string): Promise<void> {
  const pending = chains.get(botId);
  if (!pending) return;
  const deadline = requestDeadline(SETTLE_MS, "Teaching input did not finish in time.");
  try {
    await withAbort(pending, deadline.signal);
  } catch (error) {
    // The chain itself never rejects, so only the deadline can land here.
    if (!deadline.signal.aborted) throw error;
  } finally {
    deadline.dispose();
  }
}
