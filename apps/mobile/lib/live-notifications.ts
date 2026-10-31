import { requireNativeModule } from "expo-modules-core";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
import { apiBaseWarning, normalizeApiBase } from "./endpoint";
import { getActiveUiLocale, t } from "./i18n";
import { serverHeaders } from "./server-headers";

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
  setSettings(
    settings: LiveNotificationSettings,
    endpoint: string,
    token: string,
    spaceId: string,
    locale: string,
    headers: string,
  ): Promise<void>;
  resume(
    endpoint: string,
    token: string,
    spaceId: string,
    locale: string,
    headers: string,
  ): Promise<void>;
  stop(clearSession: boolean): Promise<void>;
  setOpenThread(botId: string | null, threadId: string | null): Promise<void>;
  openSettings(): Promise<void>;
  canPostPromotedNotifications(): Promise<boolean>;
  openPromotedSettings(): Promise<void>;
  /** Missing on native builds that predate the check. */
  hasPromotedSettings?: () => boolean;
};

const nativeNotifications =
  Platform.OS === "android"
    ? requireNativeModule<NativeNotifications>("RakazoNotifications")
    : null;

export type NotificationThreadTarget = { botId?: string; threadId?: string; groupId?: string };

let openThread: NotificationThreadTarget | null = null;
let lastConfirmed: NotificationThreadTarget | null = null;
let hasConfirmed = false;
let pendingReports = 0;
let reportSeq = 0;
let foregroundHandlerConfigured = false;

export function notificationTargetsThread(
  data: Record<string, unknown> | null | undefined,
  target: NotificationThreadTarget | null,
): boolean {
  if (!data || !target) return false;
  const dataThreadId = data.threadId ?? data["rakazo.threadId"];
  if (target.threadId && dataThreadId) return dataThreadId === target.threadId;
  const dataGroupId = data.groupId ?? data["rakazo.groupId"];
  if (target.groupId) return dataGroupId === target.groupId;
  // A bot's own chat, not a group it posted in.
  return Boolean(
    target.botId &&
      !dataGroupId &&
      (data.botId === target.botId || data["rakazo.botId"] === target.botId),
  );
}

export function configureForegroundNotifications(): void {
  if (foregroundHandlerConfigured) return;
  foregroundHandlerConfigured = true;
  Notifications.setNotificationHandler({
    handleNotification: async ({ request }) => {
      // Finished work is already on screen while the app is open; only questions and failures alert.
      const show =
        request.content.data?.kind !== "completion" &&
        !notificationTargetsThread(request.content.data, openThread);
      return {
        shouldShowBanner: show,
        shouldShowList: show,
        shouldPlaySound: false,
        shouldSetBadge: false,
      };
    },
  });
}

export async function getLiveNotificationSettings(): Promise<LiveNotificationSettings> {
  return nativeNotifications?.getSettings() ?? DEFAULT_LIVE_NOTIFICATION_SETTINGS;
}

export async function setLiveNotificationSettings(
  settings: LiveNotificationSettings,
  endpoint: string,
  token: string,
  spaceId: string,
): Promise<void> {
  if (!nativeNotifications) return;
  const parsed = normalizeApiBase(endpoint);
  if (!parsed.ok) throw new Error(parsed.error);
  const endpointWarning = apiBaseWarning(parsed.url);
  if (endpointWarning) throw new Error(endpointWarning);
  if (settings.liveConnection) {
    const existing = await Notifications.getPermissionsAsync();
    const granted = existing.granted || (await Notifications.requestPermissionsAsync()).granted;
    if (!granted) throw new Error(t("Android blocked notifications."));
  }
  await nativeNotifications.setSettings(
    settings,
    parsed.url,
    token,
    spaceId,
    getActiveUiLocale(),
    nativeServerHeaders(parsed.url),
  );
}

export async function resumeLiveNotifications(
  endpoint: string,
  token: string,
  spaceId: string,
): Promise<void> {
  if (!nativeNotifications || !token) return;
  const parsed = normalizeApiBase(endpoint);
  if (!parsed.ok || apiBaseWarning(parsed.url)) return;
  await nativeNotifications.resume(
    parsed.url,
    token,
    spaceId,
    getActiveUiLocale(),
    nativeServerHeaders(parsed.url),
  );
}

/** The Android poller calls the server itself, so it needs the server's headers too. */
function nativeServerHeaders(apiBase: string): string {
  const headers = serverHeaders(apiBase);
  return Object.keys(headers).length ? JSON.stringify(headers) : "";
}

export async function stopLiveNotifications(clearSession = false): Promise<void> {
  await nativeNotifications?.stop(clearSession);
}

export async function setOpenNotificationThread(
  target: NotificationThreadTarget | null,
): Promise<void> {
  // Each native call restarts the Android poller, which re-posts live notifications.
  // The foreground handler reads openThread immediately. Native is skipped only
  // for the last target it accepted when no report is pending, so overlapping
  // changes reach native and a rejection stays eligible for retry.
  openThread = target;
  if (
    pendingReports === 0 &&
    hasConfirmed &&
    lastConfirmed?.botId === target?.botId &&
    lastConfirmed?.threadId === target?.threadId
  ) {
    return;
  }
  const seq = ++reportSeq;
  pendingReports += 1;
  try {
    await nativeNotifications?.setOpenThread(target?.botId ?? null, target?.threadId ?? null);
    if (seq === reportSeq) {
      lastConfirmed = target;
      hasConfirmed = true;
    }
  } catch (error) {
    // An overlapping report may still change native state after this failure.
    hasConfirmed = false;
    throw error;
  } finally {
    pendingReports -= 1;
  }
}

export async function dismissThreadNotifications(target: NotificationThreadTarget): Promise<void> {
  if (!target.botId && !target.threadId && !target.groupId) return;
  const presented = await Notifications.getPresentedNotificationsAsync();
  await Promise.all(
    presented
      .filter(({ request }) => {
        const data = request.content.data ?? {};
        return notificationTargetsThread(data, target);
      })
      .map(({ request }) => Notifications.dismissNotificationAsync(request.identifier)),
  );
}

/** Brings this device in line after a chat's notifications were turned on or off. */
export async function afterChatNotifyChange(
  endpoint: string,
  token: string,
  spaceId: string,
  change: { threadId?: string; notify: boolean },
): Promise<void> {
  // Android's live status re-reads which chats notify.
  await resumeLiveNotifications(endpoint, token, spaceId).catch(() => undefined);
  if (!change.notify && change.threadId) {
    await dismissThreadNotifications({ threadId: change.threadId }).catch(() => undefined);
  }
}

export async function openLiveNotificationSettings(): Promise<void> {
  await nativeNotifications?.openSettings();
}

export async function canPostPromotedNotifications(): Promise<boolean> {
  return nativeNotifications?.canPostPromotedNotifications() ?? true;
}

/**
 * Android's own live update screen arrived in Android 16 and some devices
 * still lack it. Without it, the row would open general notification settings.
 */
export function hasLiveUpdateSettings(): boolean {
  if (!nativeNotifications) return false;
  if (typeof nativeNotifications.hasPromotedSettings === "function") {
    return nativeNotifications.hasPromotedSettings();
  }
  return typeof Platform.Version === "number" && Platform.Version >= 36;
}

export async function openPromotedNotificationSettings(): Promise<void> {
  await nativeNotifications?.openPromotedSettings();
}
