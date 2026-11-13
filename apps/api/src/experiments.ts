import { createHash } from "node:crypto";
import type { ExperimentKey, ExperimentVariant } from "@rakazo/contracts";
import { EXPERIMENTS } from "@rakazo/contracts";

export interface Experiments {
  /** The subject's variant; always the control unless the experiment is running. */
  variant<K extends ExperimentKey>(key: K, subjectId: string): ExperimentVariant<K>;
  /** What to pass when capturing an event the test is judged on; nothing unless it is running. */
  tags(key: ExperimentKey, subjectId: string): Record<string, string> | undefined;
  running(key: ExperimentKey): boolean;
}

/** `running` is the deployment's `EXPERIMENTS` setting: comma-separated keys. Unknown keys are ignored. */
export function createExperiments(running: string | undefined): Experiments {
  const live = new Set(
    (running ?? "")
      .split(",")
      .map((key) => key.trim())
      .filter((key): key is ExperimentKey => key in EXPERIMENTS),
  );
  const experiments: Experiments = {
    running: (key) => live.has(key),
    variant(key, subjectId) {
      const variants = EXPERIMENTS[key];
      if (!live.has(key)) return variants[0];
      // A stable split by subject: the same subject always gets the same variant.
      const bucket = createHash("sha256").update(`${key}:${subjectId}`).digest()[0]!;
      return variants[bucket % variants.length]!;
    },
    tags: (key, subjectId) =>
      live.has(key) ? { [key]: experiments.variant(key, subjectId) } : undefined,
  };
  return experiments;
}
