import type { GoalStatus } from "@rakazo/contracts";

const ALLOWED: Record<GoalStatus, GoalStatus[]> = {
  draft: ["active", "archived"],
  active: ["paused", "achieved", "archived", "failed"],
  paused: ["active", "archived", "failed"],
  achieved: ["archived"],
  archived: [],
  failed: ["draft", "archived"],
};

export function canTransitionGoal(from: GoalStatus, to: GoalStatus): boolean {
  return ALLOWED[from]?.includes(to) ?? false;
}
export function assertGoalTransition(from: GoalStatus, to: GoalStatus): void {
  if (!canTransitionGoal(from, to)) throw new Error(`Illegal Goal transition ${from} -> ${to}`);
}
