import { t } from "@lingui/core/macro";
import type { BotLiveActivity } from "@rakazo/contracts";

export function rosterHasUndismissedRunError(
  runErrorId: string | null | undefined,
  dismissedRunErrorIds: ReadonlySet<string>,
): boolean {
  return Boolean(runErrorId && !dismissedRunErrorIds.has(runErrorId));
}

/** Short sidebar label while a bot is queued, starting, or running. Null keeps the message preview. */
export function rosterWorkStatusLabel(status: string, activity?: BotLiveActivity): string | null {
  switch (status) {
    case "queued":
      return t`Waiting in line…`;
    case "leased":
      return t`Starting…`;
    case "running":
      if (activity?.kind === "step") return activity.text;
      return activity?.kind === "writing" ? t`Writing a reply…` : t`Thinking…`;
    default:
      return null;
  }
}

/** Compact rows keep actionable status visible in place of the message preview. */
export function compactRosterStatusLabel(
  status: string,
  activity?: BotLiveActivity,
): string | null {
  const workStatus = rosterWorkStatusLabel(status, activity);
  if (workStatus) return workStatus;
  switch (status) {
    case "waiting_input":
      return t`Needs an answer`;
    case "waiting_takeover":
      return t`Needs you`;
    case "failed":
      return t`Error`;
    default:
      return null;
  }
}
