import { closeSettingsSheet, isSettingsLink } from "../lib/settings-sheet";

/** A link to a screen outside settings closes the settings sheet first, so the screen opens on
 * the root stack instead of over the sheet. Settings links open inside the sheet. */
export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
  if (!isSettingsLink(path)) closeSettingsSheet();
  return path;
}
