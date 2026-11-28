/** Providers send omitted optional fields as null or blank; only anything else counts as given. */
export function argumentGiven(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  return typeof value !== "string" || value.trim().length > 0;
}

/** A list of find and replace edits counts as given only when it holds one. */
export function textEditsGiven(value: unknown): boolean {
  return Array.isArray(value) ? value.length > 0 : argumentGiven(value);
}

/** Whether a routine update writes its prompt: a whole new one, or edits to the stored one. */
export function writesRoutinePrompt(args: Record<string, unknown>): boolean {
  return argumentGiven(args.prompt) || textEditsGiven(args.promptEdits);
}
