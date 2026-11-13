import type { LabFeature } from "@rakazo/contracts";
import { LAB_FEATURES } from "@rakazo/contracts";

/** The setting that turns each Labs feature on for every account; Labs then hides it. */
const DEPLOYMENT_LAB_ENV: Record<LabFeature, string> = { board: "TICKET_BOARD_ENABLED" };

export function deploymentLabsFromEnv(source: Record<string, string | undefined>): LabFeature[] {
  return LAB_FEATURES.filter((feature) => source[DEPLOYMENT_LAB_ENV[feature]] === "true");
}
