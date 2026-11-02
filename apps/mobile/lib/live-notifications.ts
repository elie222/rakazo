import { requireNativeModule } from "expo-modules-core";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
import { apiBaseWarning, normalizeApiBase } from "./endpoint";
import { getActiveUiLocale, t } from "./i18n";
import type { ActiveSavedAccount, SavedAccount } from "./saved-accounts";
import {
  activeSavedAccount,
  loadSavedAccounts,
  saveAccountNotifications,
  servesAs,
  signedInUserIds,
} from "./saved-accounts";
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
  /** Missing on native builds that predate multiple logins. */
  setAccount?: (userId: string, label: string) => Promise<void>;
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
  /** Missing on native builds that predate pending reply invalidation. */
  resumeAfterMute?(
    endpoint: string,
    token: string,
    spaceId: string,
    locale: string,
    headers: string,
    botId: string,
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

/** Whether a delivery belongs to the active login. Older deliveries name no account. */
function ownedBy(active: ActiveSavedAccount | undefined, data: Record<string, unknown>): boolean {
  const userId = data.userId ?? data["rakazo.userId"];
  const apiBase = data.apiBase ?? data["rakazo.apiBase"];
  if (typeof apiBase === "string" && !(active && servesAs(active, apiBase))) return false;
  if (typeof userId !== "string") return (active?.count ?? 0) <= 1;
  return userId === active?.userId;
}

export function configureForegroundNotifications(): void {
  if (foregroundHandlerConfigured) return;
  foregroundHandlerConfigured = true;
  Notifications.setNotificationHandler({
    handleNotification: async ({ request }) => {
      // Finished work is already on screen while the app is open; only questions and failures alert.
      // Another login's work is not on screen.
      const data = request.content.data ?? {};
      const active = await activeSavedAccount().catch(() => undefined);
      const show =
        !ownedBy(active, data) ||
        (data.kind !== "completion" && !notificationTargetsThread(data, openThread));
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
  const active = await activeSavedAccount().catch(() => undefined);
  return (
    active?.notifications ??
    nativeNotifications?.getSettings() ??
    DEFAULT_LIVE_NOTIFICATION_SETTINGS
  );
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
  await saveAccountNotifications(parsed.url, token, settings);
  if ((await pointNativeAt(parsed.url, token)) === null) return;
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
  mutedBotId?: string,
): Promise<void> {
  if (!nativeNotifications || !token) return;
  const parsed = normalizeApiBase(endpoint);
  if (!parsed.ok || apiBaseWarning(parsed.url)) return;
  const account = await pointNativeAt(parsed.url, token);
  if (account === null) return;
  const headers = nativeServerHeaders(parsed.url);
  if (account?.notifications) {
    await nativeNotifications.setSettings(
      account.notifications,
      parsed.url,
      token,
      spaceId,
      getActiveUiLocale(),
      headers,
    );
    if (!mutedBotId || !nativeNotifications.resumeAfterMute) return;
  }
  if (mutedBotId && nativeNotifications.resumeAfterMute) {
    await nativeNotifications.resumeAfterMute(
      parsed.url,
      token,
      spaceId,
      getActiveUiLocale(),
      headers,
      mutedBotId,
    );
  } else {
    await nativeNotifications.resume(parsed.url, token, spaceId, getActiveUiLocale(), headers);
  }
}

/** The Android poller calls the server itself, so it needs the server's headers too. */
function nativeServerHeaders(apiBase: string): string {
  const headers = serverHeaders(apiBase);
  return Object.keys(headers).length ? JSON.stringify(headers) : "";
}

/**
 * Points the native poller at this login, labelled only when there are several.
 * Null means the poller stays stopped.
 */
async function pointNativeAt(
  apiBase: string,
  token: string,
): Promise<SavedAccount | undefined | null> {
  if (!nativeNotifications) return null;
  const accounts = await loadSavedAccounts(apiBase).catch(() => null);
  const account = accounts?.find((row) => row.token === token);
  // Older native builds cannot attach an account to links, so they pause for multiple logins.
  if (
    !accounts ||
    (!account && accounts.length) ||
    (accounts.length > 1 && !nativeNotifications.setAccount)
  ) {
    await nativeNotifications.stop(false);
    return null;
  }
  await nativeNotifications.setAccount?.(
    account?.userId ?? "",
    account && accounts.length > 1 ? account.email : "",
  );
  return account;
}

export async function stopLiveNotifications(clearSession = false): Promise<void> {
  if (!clearSession) return nativeNotifications?.stop(false);
  // Delivered alerts of the logins still on this device stay.
  const remaining = await signedInUserIds().catch((): string[] => []);
  // Older native builds clear every login's alerts.
  if (nativeNotifications)
    await nativeNotifications.stop(!remaining.length || Boolean(nativeNotifications.setAccount));
  const presented = await Notifications.getPresentedNotificationsAsync();
  await Promise.all(
    presented
      .filter(({ request }) => {
        const data = request.content.data ?? {};
        const userId = data.userId ?? data["rakazo.userId"];
        return typeof userId === "string" ? !remaining.includes(userId) : !remaining.length;
      })
      .map(({ request }) => Notifications.dismissNotificationAsync(request.identifier)),
  );
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
  const active = await activeSavedAccount().catch(() => undefined);
  const presented = await Notifications.getPresentedNotificationsAsync();
  await Promise.all(
    presented
      .filter(({ request }) => {
        const data = request.content.data ?? {};
        return ownedBy(active, data) && notificationTargetsThread(data, target);
      })
      .map(({ request }) => Notifications.dismissNotificationAsync(request.identifier)),
  );
}

/** Brings this device in line after a chat's notifications were turned on or off. */
export async function afterChatNotifyChange(
  endpoint: string,
  token: string,
  spaceId: string,
  change: { botId: string; threadId?: string; notify: boolean },
): Promise<void> {
  // Android also discards replies retained before this bot's own chat was muted.
  await resumeLiveNotifications(
    endpoint,
    token,
    spaceId,
    change.notify ? undefined : change.botId,
  ).catch(() => undefined);
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
