import type { WorkItemStatus } from "@rakazo/contracts";

/**
 * Valid WorkItem transitions. Keep in sync with contracts WorkItemStatusSchema.
 * Every state may transition to cancelled/failed only via defined edges where appropriate.
 */
const ALLOWED: Record<WorkItemStatus, WorkItemStatus[]> = {
  backlog: ["ready", "assigned", "cancelled"],
  ready: ["assigned", "planning", "in_progress", "blocked", "cancelled"],
  assigned: ["planning", "in_progress", "blocked", "ready", "cancelled"],
  planning: ["in_progress", "blocked", "ready", "cancelled"],
  in_progress: ["waiting_review", "waiting_approval", "blocked", "failed", "completed", "cancelled"],
  blocked: ["ready", "in_progress", "failed", "cancelled"],
  waiting_review: ["reviewing", "in_progress", "cancelled"],
  reviewing: ["completed", "in_progress", "failed", "cancelled"],
  waiting_approval: ["in_progress", "failed", "cancelled"],
  completed: [],
  failed: ["ready", "backlog", "cancelled"],
  cancelled: [],
};

export function canTransitionWorkItem(from: WorkItemStatus, to: WorkItemStatus): boolean {
  return ALLOWED[from]?.includes(to) ?? false;
}

export function assertWorkItemTransition(from: WorkItemStatus, to: WorkItemStatus): void {
  if (!canTransitionWorkItem(from, to)) {
    throw new Error(`Illegal WorkItem transition ${from} -> ${to}`);
  }
}

export function allowedTargets(from: WorkItemStatus): WorkItemStatus[] {
  return [...(ALLOWED[from] ?? [])];
}
