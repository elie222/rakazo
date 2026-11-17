/** A scheduled task that came due during a long turn, handed to the run doing that turn. */
export function dueRoutineHandoverPrompt(routineName: string | null, prompt: string): string {
  const task = routineName ? `Your scheduled task "${routineName}"` : "A scheduled task";
  return `${task} came due. Do it now, then carry on with anything you were doing.\n\n${prompt}`;
}
