import { requireNativeModule } from "expo-modules-core";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
import { apiBaseWarning } from "./endpoint";

export interface LiveNotificationSettings {
  liveConnection: boolean;
  messages: boolean;
  scheduledTasks: boolean;
  needsAttention: boolean;
}

export const DEFAULT_LIVE_NOTIFICATION_SETTINGS: LiveNotificationSettings = {
  liveConnection: false,
  messages: true,
  scheduledTasks: true,
  needsAttention: true,
};

type NativeNotifications = {
  getSettings(): Promise<LiveNotificationSettings>;
  setSettings(settings: LiveNotificationSettings, endpoint: string, token: string): Promise<void>;
  resume(endpoint: string, token: string): Promise<void>;
  stop(clearSession: boolean): Promise<void>;
  openSettings(): Promise<void>;
  canPostPromotedNotifications(): Promise<boolean>;
  openPromotedSettings(): Promise<void>;
};

const nativeNotifications =
  Platform.OS === "android"
    ? requireNativeModule<NativeNotifications>("RakazoNotifications")
    : null;

export async function getLiveNotificationSettings(): Promise<LiveNotificationSettings> {
  return nativeNotifications?.getSettings() ?? DEFAULT_LIVE_NOTIFICATION_SETTINGS;
}

export async function setLiveNotificationSettings(
  settings: LiveNotificationSettings,
  endpoint: string,
  token: string,
): Promise<void> {
  if (!nativeNotifications) return;
  const endpointWarning = apiBaseWarning(endpoint);
  if (endpointWarning) throw new Error(endpointWarning);
  if (settings.liveConnection) {
    const existing = await Notifications.getPermissionsAsync();
    const granted = existing.granted || (await Notifications.requestPermissionsAsync()).granted;
    if (!granted) throw new Error("Android blocked notifications.");
  }
  await nativeNotifications.setSettings(settings, endpoint, token);
}

export async function resumeLiveNotifications(endpoint: string, token: string): Promise<void> {
  await nativeNotifications?.resume(endpoint, token);
}

export async function stopLiveNotifications(clearSession = false): Promise<void> {
  await nativeNotifications?.stop(clearSession);
}

export async function dismissThreadNotifications(target: {
  botId?: string;
  threadId?: string;
}): Promise<void> {
  if (!target.botId && !target.threadId) return;
  const presented = await Notifications.getPresentedNotificationsAsync();
  await Promise.all(
    presented
      .filter(({ request }) => {
        const data = request.content.data ?? {};
        return (
          (target.botId &&
            (data.botId === target.botId || data["rakazo.botId"] === target.botId)) ||
          (target.threadId &&
            (data.threadId === target.threadId || data["rakazo.threadId"] === target.threadId))
        );
      })
      .map(({ request }) => Notifications.dismissNotificationAsync(request.identifier)),
  );
}

export async function openLiveNotificationSettings(): Promise<void> {
  await nativeNotifications?.openSettings();
}

export async function canPostPromotedNotifications(): Promise<boolean> {
  return nativeNotifications?.canPostPromotedNotifications() ?? true;
}

export async function openPromotedNotificationSettings(): Promise<void> {
  await nativeNotifications?.openPromotedSettings();
}
