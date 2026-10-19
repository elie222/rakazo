import { BOT_DESCRIPTION_MAX_LENGTH, BOT_INSTRUCTIONS_MAX_LENGTH } from "@rakazo/contracts";

type ProfilePatch = { description?: string; instructions?: string };

/**
 * Bot settings edit one Description field that also feeds the bot's
 * instructions, which hold far more text than a description may. Send both
 * only when that field itself changed: saving another setting must not
 * overwrite longer instructions, and a stored description above the
 * description limit must not fail every save. An edit is clamped to each
 * field's own limit, the same way a new bot's profile is derived.
 *
 * The panel trims the field before saving, so the stored value is compared
 * trimmed as well: stray whitespace around a stored description is not an
 * edit and must not drag the instructions along.
 *
 * `stored` is the description last saved from this panel, not a bot prop that
 * may still be stale when a roster refresh skips replacing the list.
 */
export function botProfilePatch(stored: string, next: string): ProfilePatch {
  if (next === stored.trim()) return {};
  return {
    description: next.slice(0, BOT_DESCRIPTION_MAX_LENGTH),
    instructions: next.slice(0, BOT_INSTRUCTIONS_MAX_LENGTH),
  };
}
