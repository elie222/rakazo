import { z } from "zod";

/** Finished features each account opts into from Settings, so they stay out of everyone's way. */
export const LAB_FEATURES = ["board"] as const;
export const LabFeatureSchema = z.enum(LAB_FEATURES);
export type LabFeature = z.infer<typeof LabFeatureSchema>;

/** The saved list, keeping only features this release still knows. */
export function parseLabs(stored: readonly string[] | null | undefined): LabFeature[] {
  return LAB_FEATURES.filter((feature) => stored?.includes(feature));
}

/** The account's own choices plus the features its deployment turns on for everyone. */
export function resolveLabs(
  stored: readonly string[] | null | undefined,
  deployment: readonly LabFeature[] = [],
): LabFeature[] {
  return LAB_FEATURES.filter((feature) => deployment.includes(feature) || hasLab(stored, feature));
}

export function hasLab(stored: readonly string[] | null | undefined, feature: LabFeature) {
  return Boolean(stored?.includes(feature));
}

export function withLab(
  stored: readonly string[] | null | undefined,
  feature: LabFeature,
  enabled: boolean,
): LabFeature[] {
  return LAB_FEATURES.filter((lab) => (lab === feature ? enabled : hasLab(stored, lab)));
}
