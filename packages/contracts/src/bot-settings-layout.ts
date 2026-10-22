/** Shared order; surfaces omit sections whose capabilities they do not expose. */
export const BOT_SETTINGS_ADVANCED_ORDER = [
  "instructions",
  "computer",
  "model",
  "thinking",
  "memoryScope",
  "readAloud",
  "voice",
  "fleetManagement",
  "scratchpad",
  "knowledge",
  "disabledTools",
  "credentials",
] as const;

/** Labels stay literal in each platform's translation calls. */
export const BOT_COMPUTER_MODES = ["team", "dedicated"] as const;
