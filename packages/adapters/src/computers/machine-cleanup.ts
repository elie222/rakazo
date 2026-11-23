import type {
  BackgroundJobAttempt,
  JobPublisher,
  SandboxProvider,
  UnreferencedMachine,
  UnreferencedMachineRecords,
} from "@rakazo/adapter-kit";
import { machineCleanupJob, machineCleanupJobKey } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { runAsSystem } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";

/** One try's provider budget; the queue's backoff spaces the tries. */
const ATTEMPT_MS = 30_000;
const STARTING = "A start that may keep this machine is still in progress";

/** Keeps each record as its keyed cleanup job, whose payload is the record. */
export function machineCleanupRecords(
  jobs: Pick<JobPublisher, "enqueue" | "cancel">,
): UnreferencedMachineRecords {
  return {
    record: (machine, deleteAt) => jobs.enqueue(machineCleanupJob(machine, deleteAt)),
    clear: (machine) => jobs.cancel(machineCleanupJobKey(machine.provider, machine.machineId)),
  };
}

/**
 * The cleanup job, which runs only for a record nothing removed: a start that stores the machine
 * removes its record in that write. It finishes once the machine is gone or a stored computer
 * points at it, and rejects otherwise so the queue tries again; the last try to fail reports the
 * machine.
 */
export async function retryMachineCleanup(
  deps: { prisma: PrismaClient; sandbox: SandboxProvider },
  machine: UnreferencedMachine,
  attempt?: BackgroundJobAttempt,
): Promise<void> {
  try {
    await deleteUnlessKept(deps, machine);
  } catch (error) {
    if (attempt && attempt.number >= attempt.max)
      getLogger().error("sandbox.cleanup_exhausted", error, {
        provider: machine.provider,
        machineId: machine.machineId,
      });
    throw error;
  }
}

async function deleteUnlessKept(
  deps: { prisma: PrismaClient; sandbox: SandboxProvider },
  machine: UnreferencedMachine,
): Promise<void> {
  const { provider, machineId, homeKey } = machine;
  // One read, so it cannot fall between a start storing the machine and leaving "booting":
  // activation does both in a single write. A start's later writes are fenced on its claim, so
  // once its computer has left "booting" without storing the machine it never will. A start that
  // died stays "booting" until the computer is started again, so its machine waits here and the
  // last try reports it.
  const holders = await runAsSystem("check whether a computer keeps a provider machine", () =>
    deps.prisma.computer.findMany({
      where: {
        OR: [
          { kind: provider, providerRef: machineId },
          ...(homeKey ? [{ homeKey, state: "booting" }] : []),
        ],
      },
      select: { state: true },
    }),
  );
  if (holders.some((holder) => holder.state === "booting")) throw new Error(STARTING);
  if (holders.length > 0) return;
  if (!deps.sandbox.deleteMachine)
    throw new Error("This computer provider cannot delete a machine by its id");
  await deps.sandbox.deleteMachine(machine, AbortSignal.timeout(ATTEMPT_MS));
}
