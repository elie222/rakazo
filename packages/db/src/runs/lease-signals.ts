// Database triggers publish these (migration `lease_change_signals`), so every writer signals.

/** Signalled when a run's status, lease owner or fence changes, or its takeover is released. */
export function runLeaseTopic(runId: string): string {
  return `run-lease:${runId}`;
}

/** Signalled when a computer's execution lease is released or something blocking it ends. */
export function computerLeaseTopic(computerId: string): string {
  return `computer-lease:${computerId}`;
}
