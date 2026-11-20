/** Shared section membership and order; surfaces omit unavailable capabilities. */
export const BOT_SETTINGS_SECTIONS = {
  openWork: ["scratchpad"],
  memory: ["knowledge"],
  advanced: [
    "useOwnMemory",
    "useSharedMemory",
    "model",
    "thinking",
    "computer",
    "memoryScope",
    "readAloud",
    "voice",
    "approvalMode",
    "dailyCheckIns",
    "crossSpaceCommunication",
    "fleetManagement",
    "maxConcurrentHelpers",
    "conversationCompaction",
    "maxToolCallsPerTurn",
    "replyMode",
    "instructions",
    "description",
    "disabledTools",
    "credentials",
    "skills",
    "export",
    "clear",
  ],
} as const;

/** Labels stay literal in each platform's translation calls. */
export const BOT_COMPUTER_MODES = ["team", "dedicated"] as const;
