import type { ProjectStatus } from "@rakazo/contracts";

const ALLOWED: Record<ProjectStatus, ProjectStatus[]> = {
  planned: ["active", "cancelled"],
  active: ["paused", "blocked", "completed", "cancelled"],
  paused: ["active", "cancelled"],
  blocked: ["active", "paused", "cancelled"],
  completed: [],
  cancelled: [],
};

export function canTransitionProject(from: ProjectStatus, to: ProjectStatus): boolean {
  return ALLOWED[from]?.includes(to) ?? false;
}
export function assertProjectTransition(from: ProjectStatus, to: ProjectStatus): void {
  if (!canTransitionProject(from, to)) throw new Error(`Illegal Project transition ${from} -> ${to}`);
}
