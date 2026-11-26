import { instructionUpdateDiff } from "@rakazo/core";
import { applyTextEdits, parseTextEdits } from "../tools/text-edits.js";

/** A long text field the reviewer sees as its changed lines only, as the owner's card shows it. */
export type ReviewedChanges = { changes: string };

export function isReviewedChanges(value: unknown): value is ReviewedChanges {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as Record<string, unknown>).changes === "string"
  );
}

/**
 * What Auto Review sees of an edit to the bot's own instructions (`update_bot`, which carries the
 * text it replaces) or a routine's prompt (`schedule_update`, given the stored prompt, whether the
 * call sends a whole prompt or edits to the stored one): the changed lines with a little context
 * instead of the whole new text, so a small edit to a long text fits the review. Unchanged lines
 * were already in force. The call is reviewed as it was when the old text is unknown or empty, or
 * when the changes leave nothing out: a rewrite or a short text reads best whole, beside the text
 * it replaces.
 */
export function changedTextReviewArgs(
  toolName: string,
  args: Record<string, unknown>,
  currentRoutinePrompt: string | undefined,
): Record<string, unknown> {
  return reshape(toolName, args, currentRoutinePrompt) ?? args;
}

function reshape(
  toolName: string,
  args: Record<string, unknown>,
  currentRoutinePrompt: string | undefined,
): Record<string, unknown> | undefined {
  if (toolName === "update_bot") {
    const {
      instructions,
      previousInstructions,
      previousInstructionsFromBaseline: _provenance,
      ...rest
    } = args;
    if (typeof instructions !== "string" || typeof previousInstructions !== "string")
      return undefined;
    if (!previousInstructions.trim()) return undefined;
    const changes = changesOf(previousInstructions, instructions);
    return changes && { ...rest, instructions: changes };
  }
  if (toolName === "schedule_update") {
    if (!currentRoutinePrompt?.trim()) return undefined;
    const { promptEdits, ...rest } = args;
    if (typeof args.prompt === "string" && args.prompt.trim()) {
      const changes = changesOf(currentRoutinePrompt, args.prompt);
      return changes && { ...args, prompt: changes };
    }
    // Edits alone do not show what they make of the text around them, so a prompt too short for
    // its changed lines to help is shown whole.
    const prompt = edited(currentRoutinePrompt, promptEdits);
    return prompt === undefined
      ? undefined
      : { ...rest, prompt: changesOf(currentRoutinePrompt, prompt) ?? prompt };
  }
  return undefined;
}

/** The prompt a call's edits make of the stored one, when they apply to it. */
function edited(prompt: string, promptEdits: unknown): string | undefined {
  const edits = parseTextEdits(promptEdits, "promptEdits");
  if (typeof edits === "string") return undefined;
  const applied = applyTextEdits(prompt, edits, "the prompt");
  return applied.ok ? applied.text : undefined;
}

/**
 * The changed lines, only when they are shorter than the new text: an unchanged text would show
 * whole with nothing to judge, and a rewrite as every old line removed and every new one added.
 */
function changesOf(before: string, after: string): ReviewedChanges | undefined {
  const changes = instructionUpdateDiff(before.trim(), after.trim());
  return before.trim() !== after.trim() && changes.length < after.trim().length
    ? { changes }
    : undefined;
}
