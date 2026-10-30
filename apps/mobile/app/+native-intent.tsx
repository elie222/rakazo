import { receiveIncomingShare } from "../lib/incoming-share";
import { closeSettingsSheet, isSettingsLink, linkScreen } from "../lib/settings-sheet";

/** A link to a screen outside settings closes the settings sheet first, so the screen opens on
 * the root stack instead of over the sheet. Settings links open inside the sheet. Something
 * shared from another app (expo-sharing opens `rakazo://expo-sharing`) opens the share target screen. */
export function redirectSystemPath({ path, initial }: { path: string; initial: boolean }): string {
  const isShare = linkScreen(path) === "expo-sharing";
  receiveIncomingShare(isShare, initial);
  if (!isSettingsLink(path)) closeSettingsSheet();
  return isShare ? "/share" : path;
}
