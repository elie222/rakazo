import { retry } from "@rakazo/core";
import { getLogger } from "@rakazo/logging";

const ATTEMPTS = 4;
/** The caller's own failure waits behind the cleanup, so the tries stop starting after this. */
const DEADLINE_MS = 60_000;

/**
 * Deletes a provider machine no stored computer points at: one left by a start that failed, or a
 * finished snapshot build's. Nothing else would delete it, so every failure is tried again, a
 * refusal included (a machine still being created refuses), and a machine that may still be there
 * after that is reported with its id. Never rejects: the failure that led here stays the one the
 * caller throws. `remove` resolves once the machine is gone, which includes never having existed.
 */
export async function deleteUnreferencedMachine(
  provider: string,
  machineId: string,
  remove: () => Promise<unknown>,
): Promise<void> {
  const signal = AbortSignal.timeout(DEADLINE_MS);
  let retried: unknown;
  try {
    await retry(remove, {
      attempts: ATTEMPTS,
      retryable: () => true,
      signal,
      onRetry: (error) => {
        retried = error;
      },
    });
  } catch (error) {
    const outOfTime = signal.aborted && error === signal.reason;
    getLogger().error("sandbox.cleanup_failed", outOfTime ? retried : error, {
      provider,
      machineId,
    });
  }
}
