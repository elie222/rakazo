const given = (value: unknown) =>
  value !== undefined && value !== null && (typeof value !== "string" || value.trim().length > 0);

/** Providers send an unused optional list blank or empty; only anything else counts as given. */
export function textEditsGiven(value: unknown): boolean {
  return Array.isArray(value) ? value.length > 0 : given(value);
}

/** Whether a routine update writes its prompt: a whole new one, or edits to the stored one. */
export function writesRoutinePrompt(args: Record<string, unknown>): boolean {
  return given(args.prompt) || textEditsGiven(args.promptEdits);
}

/** The words a routine update puts into its prompt: the whole new one, or what its edits add. */
export function writtenRoutinePromptText(args: Record<string, unknown>): string {
  if (given(args.prompt)) return String(args.prompt);
  if (!Array.isArray(args.promptEdits)) return "";
  return args.promptEdits
    .map((edit: { replace?: unknown } | null) =>
      typeof edit?.replace === "string" ? edit.replace : "",
    )
    .join("\n");
}
