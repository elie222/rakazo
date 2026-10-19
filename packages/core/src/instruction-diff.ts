/** A full replacement diff keeps every removed constraint visible during approval. */
export function instructionUpdateDiff(before: string, after: string, reason: string): string {
  return `${reason}\n\n${before
    .split("\n")
    .map((line) => `- ${line}`)
    .join("\n")}\n${after
    .split("\n")
    .map((line) => `+ ${line}`)
    .join("\n")}`;
}
