/**
 * A scheduled task that came due during a long turn, handed to the run doing that turn. If that
 * run ends before reading it, the same text starts a run of its own.
 */
export function dueRoutineHandoverPrompt(routineName: string | null, prompt: string): string {
  const task = routineName ? `Your scheduled task "${routineName}"` : "A scheduled task";
  return `${task} came due. Do it now:\n\n${prompt}`;
}
