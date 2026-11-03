import {
  ANDROID_APK_URL,
  buildIdAt,
  CLIENT_BUILD_HEADER,
  formatClientBuild,
  IOS_APP_STORE_URL,
} from "@rakazo/contracts";
import * as Updates from "expo-updates";
import type { AppStateStatus } from "react-native";
import { Alert, AppState, Linking, Platform } from "react-native";
import { configureClientBuild } from "./api";
import { t } from "./i18n";

/** Foreground returns closer together than this reuse the last update check. */
export const FOREGROUND_UPDATE_CHECK_MS = 15 * 60_000;

/**
 * The running JavaScript bundle's build: when its update (embedded or downloaded) was created.
 * Null where expo-updates is off (development, Expo Go), which leaves the handshake off.
 */
export function mobileClientBuild(): string | null {
  try {
    if (!Updates.isEnabled) return null;
    const created = Updates.createdAt;
    return created instanceof Date && !Number.isNaN(created.getTime()) ? buildIdAt(created) : null;
  } catch {
    return null;
  }
}

export function clientBuildHeaders(): Record<string, string> {
  const build = mobileClientBuild();
  return build ? { [CLIENT_BUILD_HEADER]: formatClientBuild("mobile", build) } : {};
}

/** Download a newer update; expo-updates runs it on the next launch unless the app reloads. */
async function downloadUpdate(): Promise<boolean> {
  if (!Updates.isEnabled) return false;
  const check = await Updates.checkForUpdateAsync();
  if (!check.isAvailable) return false;
  await Updates.fetchUpdateAsync();
  return true;
}

/** Apply an over-the-air update now if one exists; otherwise send the user to the store. */
export async function applyRequiredUpdate(): Promise<void> {
  try {
    if (await downloadUpdate()) {
      await Updates.reloadAsync();
      return;
    }
  } catch {
    // An unreachable update server falls through to the store.
  }
  await Linking.openURL(Platform.OS === "ios" ? IOS_APP_STORE_URL : ANDROID_APK_URL).catch(
    () => undefined,
  );
}

let prompting = false;

/** The server refused this build. One alert at a time; it stays until the user updates. */
export function noteClientUpdateRequired(): void {
  if (prompting) return;
  prompting = true;
  Alert.alert(
    t("Update required"),
    undefined,
    [
      {
        text: t("Update"),
        onPress: () => {
          void applyRequiredUpdate().finally(() => {
            prompting = false;
          });
        },
      },
    ],
    { cancelable: false },
  );
}

/** Name this build on every API request, and prompt for an update when the server refuses it. */
export function installClientUpdates(): void {
  configureClientBuild({ headers: clientBuildHeaders, onUpdateRequired: noteClientUpdateRequired });
}

/**
 * expo-updates checks only at launch. Check again when the app returns to the foreground, and
 * download what it finds so the next launch runs it; nothing reloads under the user.
 */
export function watchForegroundUpdates(now: () => number = Date.now): () => void {
  if (!Updates.isEnabled) return () => {};
  let lastCheck = now();
  let wasBackground = false;
  const subscription = AppState.addEventListener("change", (state: AppStateStatus) => {
    if (state === "background") wasBackground = true;
    if (state !== "active" || !wasBackground) return;
    wasBackground = false;
    if (now() - lastCheck < FOREGROUND_UPDATE_CHECK_MS) return;
    lastCheck = now();
    void downloadUpdate().catch(() => undefined);
  });
  return () => subscription.remove();
}
