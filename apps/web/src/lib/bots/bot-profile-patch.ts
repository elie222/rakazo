import { BOT_DESCRIPTION_MAX_LENGTH } from "@rakazo/contracts";
import { sliceWellFormed } from "@rakazo/core";

/** Instructions are edited separately; profile edits must preserve them. */
export function botProfilePatch(stored: string, next: string): { description?: string } {
  if (next === stored.trim()) return {};
  return { description: sliceWellFormed(next, BOT_DESCRIPTION_MAX_LENGTH) };
}
