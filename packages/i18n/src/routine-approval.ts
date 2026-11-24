import { ph, t } from "@lingui/core/macro";
import type { RoutineApprovalChange, RoutineApprovalField } from "@rakazo/contracts";

export function routineApprovalLabel(field: RoutineApprovalField): string {
  switch (field) {
    case "active":
      return t`Status`;
    case "name":
      return t`Name`;
    case "schedule":
      return t`Schedule`;
    case "timezone":
      return t`Time zone`;
    case "nextRun":
      return t`Next run`;
    case "inChat":
      return t`Where it runs`;
    case "prompt":
      return t`New instructions`;
  }
}

export function routineApprovalValue(
  field: RoutineApprovalField,
  value: RoutineApprovalChange["after"],
): string {
  if (value === null || value === "") return t`None`;
  if (typeof value === "string") return value;
  if (field === "inChat") return value ? t`In this chat` : t`Separately from this chat`;
  return value ? t`Active` : t`Paused`;
}

export function routineApprovalPrevious(value: string): string {
  return t`Previously: ${ph({ value })}`;
}

export function routineApprovalActionLabel(id: string): string | undefined {
  if (id === "allow") return t`Approve once`;
  if (id === "deny") return t`Decline`;
  if (id === "always") return t`Always allow routine updates`;
}
