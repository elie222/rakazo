import type { RunStatus } from "@rakazo/contracts";

export const ACTIVE_RUN_STATUSES = [
  "queued",
  "leased",
  "running",
  "waiting_input",
  "waiting_takeover",
] as const satisfies readonly RunStatus[];
const TERMINAL: RunStatus[] = ["completed", "failed", "cancelled"];

const allowed: Record<RunStatus, RunStatus[]> = {
  queued: ["leased", "cancelled"],
  leased: ["running", "queued", "cancelled"],
  running: ["waiting_input", "waiting_takeover", "completed", "failed", "cancelled", "leased"],
  waiting_input: ["queued", "leased", "cancelled"],
  waiting_takeover: ["queued", "leased", "cancelled"],
  completed: [],
  failed: ["queued"],
  cancelled: [],
};

export function canTransition(from: RunStatus, to: RunStatus): boolean {
  return allowed[from]?.includes(to) ?? false;
}

export function assertTransition(from: RunStatus, to: RunStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(`Illegal run transition ${from} -> ${to}`);
  }
}

export function isActive(status: RunStatus): boolean {
  return (ACTIVE_RUN_STATUSES as readonly RunStatus[]).includes(status);
}

export function isTerminal(status: RunStatus): boolean {
  return TERMINAL.includes(status);
}

export function nextFence(current: number): number {
  return current + 1;
}
