import { automated } from "./automated-messages.prompt.js";

/** Hands a scheduled task that came due during a long turn to the run doing that turn. */
export function dueRoutineHandoverPrompt(routineName: string | null, prompt: string): string {
  const task = routineName ? `Your scheduled task "${routineName}"` : "A scheduled task";
  return [
    automated(
      `${task} came due while you were working. Do it now, then carry on with what you were doing. The task:`,
    ),
    "",
    prompt,
  ].join("\n");
}
