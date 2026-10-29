import type { RunStatus } from "@rakazo/contracts";

/** Runs the bot is working on, which the chat shows as working. */
export const WORKING_RUN_STATUSES = [
  "queued",
  "leased",
  "running",
] as const satisfies readonly RunStatus[];
/** Runs paused on the user: an answer, an approval, or a computer takeover. Their card is the state. */
export const WAITING_ON_USER_RUN_STATUSES = [
  "waiting_input",
  "waiting_takeover",
] as const satisfies readonly RunStatus[];
export const ACTIVE_RUN_STATUSES = [
  ...WORKING_RUN_STATUSES,
  ...WAITING_ON_USER_RUN_STATUSES,
] as const satisfies readonly RunStatus[];
/** Runs that hold new work in the queue. A pending card holds no compute. */
export const QUEUE_HOLDING_RUN_STATUSES = ACTIVE_RUN_STATUSES.filter(
  (status) => status !== "waiting_input",
);
const TERMINAL: RunStatus[] = ["completed", "failed", "cancelled"];
/**
 * These turns carry their own prompt and must not take a user message as steering.
 * Routine and webhook runs are not the conversation, and neither is a wake from another bot:
 * its reply goes back to that bot. The creation intro can only ask what it is for; a message
 * that lands during any of them waits, and the continuation after the turn finishes answers it.
 */
const NON_CONVERSATIONAL_RUN_TRIGGERS = new Set([
  "routine",
  "webhook",
  "created",
  "tickets",
  "bot_message",
]);

/**
 * Background triggers do internal work that must not leak into the chat: the
 * sidebar must not show them as activity and the bot transcript must not render
 * their steps/text. Ticket work reports through board comments and its status.
 * Existing ask and approval cards can still request user input.
 */
export const BACKGROUND_RUN_TRIGGERS = ["tickets"] as const;
const BACKGROUND_RUN_TRIGGER_SET = new Set<string>(BACKGROUND_RUN_TRIGGERS);

export function isBackgroundRunTrigger(trigger: string | null | undefined): boolean {
  return BACKGROUND_RUN_TRIGGER_SET.has(trigger ?? "");
}

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

export function isRunWorking(status: string | null | undefined): boolean {
  return WORKING_RUN_STATUSES.some((working) => working === status);
}

export function isRunWaitingOnUser(status: string | null | undefined): boolean {
  return WAITING_ON_USER_RUN_STATUSES.some((waiting) => waiting === status);
}

export function isTerminal(status: RunStatus): boolean {
  return TERMINAL.includes(status);
}

/** Prompt of a run created to answer messages that waited behind another turn. */
export const STEERING_CONTINUATION_PROMPT = "Respond to the user's steering context.";

/** Routine runs and the creation intro stay isolated from thread history. */
export function runReadsThreadHistory(trigger: string | null | undefined): boolean {
  return trigger !== "created" && trigger !== "routine";
}

/** Whether a run's turn is part of the thread's conversation and may take user steering. */
export function isConversationalRun(trigger: string | null | undefined): boolean {
  return !NON_CONVERSATIONAL_RUN_TRIGGERS.has(trigger ?? "");
}

/**
 * A takeover wait holds only a conversational message it can take as steering. Any other
 * message passes it and gets its own run; the dispatcher then ends a wait the user has not
 * acted on so that run can start. `steerable` is false for messages that never steer a run,
 * such as webhook deliveries.
 */
export function messageBypassesTakeoverWait(
  run: { status?: string; trigger?: string | null },
  steerable = true,
): boolean {
  return run.status === "waiting_takeover" && !(steerable && isConversationalRun(run.trigger));
}

export function nextFence(current: number): number {
  return current + 1;
}
