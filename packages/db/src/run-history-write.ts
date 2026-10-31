export interface RunHistoryWriteLease {
  owner: string;
  fence: number;
}

export type RunHistoryWriteBlock = "missing" | "cancelled" | "superseded";

/**
 * Whether a loaded run row may take a history write from this attempt.
 * A null owner with the same fence is a pause or finish: the attempt still owns the row.
 * A missing lease checks cancellation only. The database lock stays with the caller.
 */
export function runHistoryWriteBlock(
  run: { status: string; leaseOwner: string | null; leaseFence: number } | null,
  options?: { allowCancelled?: boolean; lease?: RunHistoryWriteLease },
): RunHistoryWriteBlock | null {
  if (!run) return "missing";
  if (run.status === "cancelled" && !options?.allowCancelled) return "cancelled";
  const lease = options?.lease;
  if (
    lease &&
    (run.leaseFence !== lease.fence || (run.leaseOwner !== null && run.leaseOwner !== lease.owner))
  ) {
    return "superseded";
  }
  return null;
}
