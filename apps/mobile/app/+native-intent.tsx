import { closeSettingsSheet, isSettingsLink, linkScreen } from "../lib/settings-sheet";

/** A link to a screen outside settings closes the settings sheet first, so the screen opens on
 * the root stack instead of over the sheet. Settings links open inside the sheet. Something
 * shared from another app (expo-sharing opens `rakazo://expo-sharing`) goes to the inbox, and
 * the chat picked there receives it. */
export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
  if (!isSettingsLink(path)) closeSettingsSheet();
  return linkScreen(path) === "expo-sharing" ? "/" : path;
}
