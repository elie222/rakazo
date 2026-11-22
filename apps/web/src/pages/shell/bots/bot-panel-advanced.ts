import type { Bot } from "@rakazo/contracts";
import { modelOptionKey } from "@rakazo/core";

/** The fields saved together as soon as one changes, in the order their saved snapshot keeps them. */
export function advancedValues(bot: Bot) {
  return [
    bot.modelProvider && bot.modelId ? modelOptionKey(bot.modelProvider, bot.modelId) : "",
    bot.thinkingLevel ?? "",
    bot.computerMode,
    bot.autoSpeak,
    bot.voiceId ?? "",
  ] as const;
}
