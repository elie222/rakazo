import {
  MOBILE_APP_CONNECT_CALLBACK_URL,
  MOBILE_MCP_OAUTH_CALLBACK_URL,
  MOBILE_MEETING_CALENDAR_CALLBACK_URL,
} from "@rakazo/contracts";
import { receiveIncomingShare } from "../lib/composer/incoming-share";
import { finishReturnedAppConnection } from "../lib/integrations/app-connect-return";
import { closeSettingsSheet, isSettingsLink, linkScreen } from "../lib/settings/settings-sheet";

const browserCallbacks = new Set(
  [
    MOBILE_APP_CONNECT_CALLBACK_URL,
    MOBILE_MCP_OAUTH_CALLBACK_URL,
    MOBILE_MEETING_CALENDAR_CALLBACK_URL,
  ].map(linkScreen),
);

/** A link to a screen outside settings closes the settings sheet first, so the screen opens on
 * the root stack instead of over the sheet. Settings links open inside the sheet. Something
 * shared from another app (expo-sharing opens `rakazo://expo-sharing`) opens the share target screen. */
export function redirectSystemPath({ path, initial }: { path: string; initial: boolean }): string {
  const screen = linkScreen(path);
  const isShare = screen === "expo-sharing";
  receiveIncomingShare(isShare, initial);
  // The in-app browser already handed this to the sign-in that opened it; stay put.
  if (browserCallbacks.has(screen)) {
    if (screen === linkScreen(MOBILE_APP_CONNECT_CALLBACK_URL)) finishReturnedAppConnection(path);
    return "";
  }
  if (!isSettingsLink(path)) closeSettingsSheet();
  return isShare ? "/share" : path;
}
