import type { UnreferencedMachine, UnreferencedMachineRecords } from "@rakazo/adapter-kit";
import { deadlineSignal, retry, withAbort } from "@rakazo/core";
import { bestEffort, getLogger } from "@rakazo/logging";

const ATTEMPTS = 4;
/**
 * The caller's own failure waits behind the cleanup, and often a person waits behind that, so
 * every try and pause together end within this. A healthy delete answers in a second or two.
 */
const BUDGET_MS = 20_000;
/** One try that hangs leaves time for another. */
const ATTEMPT_MS = 10_000;

/**
 * How long a start is taken to need its new machine before it is stored. A start has normally
 * stored or deleted it well before; the backup waits out one still running.
 */
const START_MS = 15 * 60_000;
/** Lets the caller's own delete finish before the backup is due. */
const BACKUP_MARGIN_MS = 60_000;

/**
 * Records a machine the moment its id is known, before a later step can fail or the process can
 * die. Its delete is due once the caller can no longer be using it, `usedForMs` from now, unless
 * a computer stores it or `deleteUnreferencedMachine` removes it first. Never rejects: a start
 * does not fail because its backup could not be written.
 */
export async function recordUnreferencedMachine(
  records: UnreferencedMachineRecords | undefined,
  machine: UnreferencedMachine,
  usedForMs = START_MS,
): Promise<void> {
  await bestEffort(
    "record a provider machine no computer stores yet",
    writeRecord(records, machine, new Date(Date.now() + usedForMs + BACKUP_MARGIN_MS)),
  );
}

/** The record is all that deletes its machine later, so a write that fails is tried again. */
async function writeRecord(
  records: UnreferencedMachineRecords | undefined,
  machine: UnreferencedMachine,
  deleteAt: Date,
): Promise<void> {
  if (!records) return;
  await retry(() => records.record(machine, deleteAt), {
    attempts: 3,
    retryable: () => true,
    delayMs: [200, 1_000],
  });
}

/**
 * Deletes a provider machine no stored computer points at: one left by a start that failed, or a
 * finished snapshot build's. Nothing else would delete it, so every failure is tried again, a
 * refusal included (a machine still being created refuses), and a machine that may still be there
 * after that is reported with its id and, where the provider was built with `records`, handed to
 * them to delete later. Never rejects: the failure that led here stays the one the caller throws.
 * `remove` resolves once the machine is gone, which includes never having existed.
 *
 * `remove` gets the signal that ends its try and the time that try has left, for a client that
 * takes a timeout instead. A try that ignores both is no longer waited for once its time is up.
 */
export async function deleteUnreferencedMachine(
  records: UnreferencedMachineRecords | undefined,
  machine: UnreferencedMachine,
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
    getLogger().error("sandbox.cleanup_failed", failure, {
      provider: machine.provider,
      machineId: machine.machineId,
    });
    await bestEffort(
      "hand a provider machine that could not be deleted to its backup",
      writeRecord(records, machine, new Date()),
    );
    return;
  }
  await bestEffort("drop the record of a deleted provider machine", records?.clear(machine));
}
