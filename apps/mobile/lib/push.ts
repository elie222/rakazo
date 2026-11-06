import { newClientId } from "@rakazo/core";
import Constants from "expo-constants";
import { requireOptionalNativeModule } from "expo-modules-core";
import * as Notifications from "expo-notifications";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";
import { currentApiBase, loadSessionToken, rpc, selectedSpaceId } from "./api";
import { resumeLiveNotifications } from "./live-notifications";
import { currentSessionGeneration } from "./session";

async function notificationsAllowed() {
  // On iOS getPermissionsAsync holds Expo's shared native queue until the system answers,
  // which can take minutes after a restart, and SecureStore waits behind it. The request
  // does not hold the queue and only prompts while the user hasn't chosen yet.
  if (Platform.OS === "ios") return (await Notifications.requestPermissionsAsync()).granted;
  const existing = await Notifications.getPermissionsAsync();
  return existing.granted || (await Notifications.requestPermissionsAsync()).granted;
}

export async function registerPushToken() {
  if (!(await notificationsAllowed())) return;
  try {
    const projectId = Constants.easConfig?.projectId ?? Constants.expoConfig?.extra?.eas?.projectId;
    if (!projectId) return;
    const token = (await Notifications.getExpoPushTokenAsync({ projectId })).data;
    if (!token) return;
    const generation = currentSessionGeneration();
    const apiBase = currentApiBase();
    const sessionToken = await loadSessionToken();
    // A sign-in still saving its token registers again once the session lands.
    if (!sessionToken) return;
    if (generation !== currentSessionGeneration() || apiBase !== currentApiBase()) return;
    // The server can push the moment this registration lands, before any Space load
    // resumes native notifications; sync the session first, so Android's signed-out
    // drop rule sees this account instead of the blank of a fresh sign-in. A rejected
    // resume means native never stored this session: registering would have Android
    // drop every push, so leave the token unregistered for the next attempt to retry.
    // A server native notifications skip (public http) keeps no native session, so it
    // gets plain pushes, which the drop rule never sees.
    let nativeSession: boolean;
    try {
      nativeSession = await resumeLiveNotifications(apiBase, sessionToken, selectedSpaceId() ?? "");
    } catch {
      return;
    }
    await rpc("notifications/registerPush", {
      token,
      ...(Platform.OS === "android" &&
      nativeSession &&
      requireOptionalNativeModule<{ supportsSenderAvatars?: boolean }>("RakazoNotifications")
        ?.supportsSenderAvatars
        ? { presentation: "android_sender" as const }
        : {}),
    });
    await registerCallPushToken({ expoToken: token });
  } catch {
    // Expo Go without an EAS project id and Android builds without a Firebase config
    // cannot mint an Expo push token.
  }
}

export async function unregisterPushToken() {
  await rpc("notifications/unregisterPush").catch(() => undefined);
}

let callTokens: { expoToken?: string; voipToken?: string } = {};
let tokenGeneration = -1;
let registeredKey: string | undefined;
let deviceIdPromise: Promise<string> | undefined;
async function installationId() {
  deviceIdPromise ??= (async () => {
    const stored = await SecureStore.getItemAsync("rakazo.call-device");
    if (stored) return stored;
    const id = newClientId();
    await SecureStore.setItemAsync("rakazo.call-device", id);
    return id;
  })();
  const pending = deviceIdPromise;
  try {
    return await pending;
  } catch (error) {
    if (deviceIdPromise === pending) deviceIdPromise = undefined;
    throw error;
  }
}
/** Builds without native call handling keep the account's ordinary push for incoming calls. */
const nativeCalls = Boolean(
  requireOptionalNativeModule<{ incomingState?: unknown }>("RakazoNotifications")?.incomingState,
);

export async function registerCallPushToken(tokens: { expoToken?: string; voipToken?: string }) {
  if (!nativeCalls) return;
  const generation = currentSessionGeneration();
  if (generation !== tokenGeneration) {
    callTokens = {};
    registeredKey = undefined;
    tokenGeneration = generation;
  }
  const registration = { ...callTokens, ...tokens };
  const key = JSON.stringify(registration);
  if (key === registeredKey) return;
  callTokens = registration;
  const deviceId = await installationId();
  if (generation !== currentSessionGeneration()) return;
  if (Platform.OS !== "ios" && Platform.OS !== "android") return;
  await rpc("notifications/registerCallPush", { deviceId, platform: Platform.OS, ...registration });
  if (generation === currentSessionGeneration()) registeredKey = key;
}
