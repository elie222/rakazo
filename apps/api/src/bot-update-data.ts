import type { UpdateBotInput } from "@rakazo/contracts";

/**
 * The shared bot's own fields an update writes. `notifyOnFinish` is left out: a member's
 * notifications are their own mute, saved apart from the bot.
 */
export function botUpdateData(input: UpdateBotInput, avatarSetPinned: boolean | undefined) {
  return {
    name: input.name,
    description: input.description,
    instructions: input.instructions,
    color: input.color,
    avatarSet: input.avatarSet,
    avatarSetPinned,
    pinned: input.pinned,
    memoryScope: input.memoryScope,
    sectionId: input.sectionId,
    voiceId: input.voiceId,
    autoSpeak: input.autoSpeak,
    ...(input.modelProvider !== undefined
      ? { modelProvider: input.modelProvider, modelId: input.modelId ?? null }
      : {}),
    ...(input.thinkingLevel !== undefined ? { thinkingLevel: input.thinkingLevel } : {}),
    ...(input.teamChatAmbientEnabled !== undefined
      ? { teamChatAmbientEnabled: input.teamChatAmbientEnabled }
      : {}),
    ...(input.teamChatRules !== undefined ? { teamChatRules: input.teamChatRules } : {}),
    ...(input.crossSpaceCommunication !== undefined
      ? { crossSpaceCommunication: input.crossSpaceCommunication }
      : {}),
    ...(input.dailyCheckIns !== undefined ? { dailyCheckIns: input.dailyCheckIns } : {}),
    ...(input.fleetManagement !== undefined ? { fleetManagement: input.fleetManagement } : {}),
    ...(input.replyMode !== undefined ? { replyMode: input.replyMode } : {}),
    ...(input.disabledBuiltinTools !== undefined
      ? { disabledBuiltinTools: input.disabledBuiltinTools }
      : {}),
  };
}
