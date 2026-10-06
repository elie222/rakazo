import type { PatrolParams } from "./prompts.js";
import {
  buildPatrolUser,
  ESCALATION_TEMPERATURE,
  OUTPUT_CONTRACT,
  P1_NEWSROOM_FRAME,
  PATROL_TEMPERATURE,
} from "./prompts.js";
export const POTOO_PATROL_MARKER = "Tonight's assignment.";
export const POTOO_ESCALATION_MARKER = "Reporter's filing:";
export const POTOO_REPAIR_MARKER = "[potoo-repair:";

export type PotooRepairKind = "patrol" | "escalation";

export function repairMarker(kind: PotooRepairKind): string {
  return `[potoo-repair: ${kind}]`;
}

export function isPotooRepair(prompt: string): boolean {
  return prompt.includes(POTOO_REPAIR_MARKER);
}

export type DetectedPotooFlight = {
  temperature: number;
  systemPrefix: string;
};

/**
 * Build the task/routine prompt for a patrol flight: the beat brief
 * followed by the night assignment. Self-contained so the run needs
 * no beat-file reads; the executor prepends the newsroom frame plus
 * the output contract to the system instructions (see detectPotooFlight).
 * One documented deviation from the paper assembly: the beat brief
 * travels in the user prompt rather than the system prompt.
 */
export function buildPotooRoutinePrompt(beatBrief: string, params: PatrolParams): string {
  return `${beatBrief.trim()}\n\n${buildPatrolUser(params)}`;
}

export function detectPotooFlight(prompt: string): DetectedPotooFlight | null {
  const systemPrefix = `${P1_NEWSROOM_FRAME}\n\n${OUTPUT_CONTRACT}`;
  if (prompt.includes(POTOO_PATROL_MARKER)) {
    return { temperature: PATROL_TEMPERATURE, systemPrefix };
  }
  if (prompt.includes(POTOO_ESCALATION_MARKER)) {
    return { temperature: ESCALATION_TEMPERATURE, systemPrefix };
  }
  if (prompt.includes(POTOO_REPAIR_MARKER)) {
    // Copy repair reuses the original flight's system and temperature.
    const temperature = prompt.includes(repairMarker("escalation"))
      ? ESCALATION_TEMPERATURE
      : PATROL_TEMPERATURE;
    return { temperature, systemPrefix };
  }
  return null;
}
