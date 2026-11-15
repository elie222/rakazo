import { deadlineSignal, retry, withAbort } from "@rakazo/core";
import { getLogger } from "@rakazo/logging";

const ATTEMPTS = 4;
/**
 * The caller's own failure waits behind the cleanup, and often a person waits behind that, so
 * every try and pause together end within this. A healthy delete answers in a second or two.
 */
const BUDGET_MS = 20_000;
/** One try that hangs leaves time for another. */
const ATTEMPT_MS = 10_000;

/**
 * Deletes a provider machine no stored computer points at: one left by a start that failed, or a
 * finished snapshot build's. Nothing else would delete it, so every failure is tried again, a
 * refusal included (a machine still being created refuses), and a machine that may still be there
 * after that is reported with its id. Never rejects: the failure that led here stays the one the
 * caller throws. `remove` resolves once the machine is gone, which includes never having existed.
 *
 * `remove` gets the signal that ends its try and the time that try has left, for a client that
 * takes a timeout instead. A try that ignores both is no longer waited for once its time is up.
 */
export async function deleteUnreferencedMachine(
  provider: string,
  machineId: string,
  remove: (signal: AbortSignal, timeoutMs: number) => Promise<unknown>,
): Promise<void> {
  const budget = deadlineSignal(BUDGET_MS);
  const endsAt = Date.now() + BUDGET_MS;
  let failure: unknown;
  try {
    await retry(
      async () => {
        const timeoutMs = Math.max(1, Math.min(ATTEMPT_MS, endsAt - Date.now()));
        const signal = deadlineSignal(timeoutMs, budget);
        try {
          await withAbort(remove(signal, timeoutMs), signal);
        } catch (error) {
          failure = error;
          throw error;
        }
      },
      { attempts: ATTEMPTS, retryable: () => true, signal: budget },
    );
  } catch {
    getLogger().error("sandbox.cleanup_failed", failure, { provider, machineId });
  }
}
