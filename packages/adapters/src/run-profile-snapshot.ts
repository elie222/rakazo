import { BotRuntimeProfile, type BotRuntimeProfile as Profile } from "@rakazo/contracts";

export type RuntimeProfileSnapshot = {
  revision: number;
  settings: Profile;
};

export function parseRunProfileSnapshot(value: unknown): RuntimeProfileSnapshot | null {
  if (value == null) return null;
  if (typeof value !== "object" || Array.isArray(value))
    throw new TypeError("Invalid run profile snapshot");
  const snapshot = value as { revision?: unknown; settings?: unknown };
  if (!Number.isSafeInteger(snapshot.revision) || (snapshot.revision as number) < 0) {
    throw new TypeError("Invalid run profile snapshot revision");
  }
  return {
    revision: snapshot.revision as number,
    settings: BotRuntimeProfile.parse(snapshot.settings),
  };
}

export function createRunProfileSnapshot(
  revision: number,
  settings: unknown,
): RuntimeProfileSnapshot {
  if (!Number.isSafeInteger(revision) || revision < 0)
    throw new RangeError("Invalid profile revision");
  return { revision, settings: BotRuntimeProfile.parse(settings) };
}
