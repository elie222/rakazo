import type { RunStatus } from "@rakazo/contracts";

export const ACTIVE_RUN_STATUSES = [
  "queued",
  "leased",
  "running",
  "waiting_input",
  "waiting_takeover",
] as const satisfies readonly RunStatus[];
const TERMINAL: RunStatus[] = ["completed", "failed", "cancelled"];
/**
 * These turns carry their own prompt and must not take a user message as steering.
 * Routine and webhook runs are not the conversation. The creation intro has no tools;
 * a message that lands during it waits, and the continuation after the intro finishes answers it.
 */
const NON_CONVERSATIONAL_RUN_TRIGGERS = new Set(["routine", "webhook", "created"]);

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

/** Whether a run's turn is part of the thread's conversation and may take user steering. */
export function isConversationalRun(trigger: string | null | undefined): boolean {
  return !NON_CONVERSATIONAL_RUN_TRIGGERS.has(trigger ?? "");
}

export function nextFence(current: number): number {
  return current + 1;
}
