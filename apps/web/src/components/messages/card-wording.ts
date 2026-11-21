import { t } from "@lingui/core/macro";
import { ALLOW_IN_SPACE_LABELS } from "@rakazo/core";

/**
 * The words on an approval card's button. The server stores English labels; the card says them in
 * the reader's language. The chat export writes the same words.
 */
export function approvalActionLabel(
  action: { id: string; label: string; outcome?: "created" | "cancelled" },
  instructionUpdate: boolean,
  site?: string,
): string {
  if (action.id === "edit") return action.label;
  if (instructionUpdate) return action.id === "allow" ? t`Apply` : t`Dismiss`;
  if (action.outcome === "created") return t`Create space`;
  if (action.outcome === "cancelled") return t`Cancel`;
  if (action.id === "allow")
    return ALLOW_IN_SPACE_LABELS.has(action.label) ? t`Allow in this space` : t`Allow once`;
  if (action.id === "always") return site ? t`Always allow ${site}` : t`Always allow this tool`;
  if (action.id === "deny") return t`Deny`;
  return action.label;
}

const FOCUS_QUESTION = "What do you want me on first?";

/** The first-run focus question: the API stores English, which the reader's catalog translates. */
export function onboardingFocusQuestion(question: string): string {
  return question === FOCUS_QUESTION ? t`What do you want me on first?` : question;
}

/** A first-run focus option, translated by its id; any other choice keeps its stored label. */
export function onboardingFocusOptionLabel(
  option: { id: string; label: string },
  question: string,
): string {
  if (question !== FOCUS_QUESTION) return option.label;
  switch (option.id) {
    case "day":
      return t`Day-to-day work`;
    case "inbox":
      return t`Inbox & email`;
    case "research":
      return t`Research & writing`;
    case "everything":
      return t`A bit of everything`;
    default:
      return option.label;
  }
}
