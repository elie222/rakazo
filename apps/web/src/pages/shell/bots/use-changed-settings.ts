import type { Bot } from "@rakazo/contracts";
import { useState } from "react";

/**
 * Settings this panel only shows once they differ from their defaults: a row appears when
 * the bot has it changed and stays while it is being edited, so newer bot data can reveal
 * one but never hide one mid-edit.
 */
export function useChangedSettings(bot: Bot) {
  // A setting this panel no longer offers still shows while the bot has it changed from the
  // default, so it can be put back. Decided once, so the row stays to undo a change.
  const changedNow = {
    readAloud: bot.autoSpeak || Boolean(bot.voiceId),
    dailyCheckIns: bot.dailyCheckIns === false,
    crossSpaceCommunication: bot.crossSpaceCommunication === false,
    fleetManagement: !bot.fleetManagement,
    tools: (bot.disabledBuiltinTools ?? []).length > 0,
  };
  // Once shown, a row stays, so newer bot data can reveal one but never hide one mid-edit.
  const [changedBefore, setChangedBefore] = useState(changedNow);
  const changed = {
    readAloud: changedBefore.readAloud || changedNow.readAloud,
    dailyCheckIns: changedBefore.dailyCheckIns || changedNow.dailyCheckIns,
    crossSpaceCommunication:
      changedBefore.crossSpaceCommunication || changedNow.crossSpaceCommunication,
    fleetManagement: changedBefore.fleetManagement || changedNow.fleetManagement,
    tools: changedBefore.tools || changedNow.tools,
  };
  if (
    Object.entries(changed).some(([key, on]) => on !== changedBefore[key as keyof typeof changed])
  )
    setChangedBefore(changed);
  return changed;
}
