import * as Notifications from "expo-notifications";
import { router } from "expo-router";
import { useEffect } from "react";
import { Alert } from "react-native";
import { selectNotificationAccount } from "./account-sessions";
import { currentApiBase } from "./api";
import { t } from "./i18n";
import {
  notificationResponseRoute,
  notificationTargetLink,
  threadRouteId,
} from "./notification-open";
import { closeSettingsSheet } from "./settings-sheet";

const openedResponses = new Set<string>();
let openAttempt = 0;

/** Expo's request identifier is the scheduled request. These pushes use the
 * thread id for that value, so a later delivery of the same thread shares it.
 * The payload delivery id is the occurrence. */
function occurrenceKey(response: Notifications.NotificationResponse): string | null {
  const identifier = response.notification.request.identifier;
  if (!identifier) return null;
  const data = response.notification.request.content.data;
  const deliveryId =
    data && typeof data === "object" && !Array.isArray(data)
      ? (data as Record<string, unknown>).deliveryId
      : undefined;
  const occurrence = typeof deliveryId === "string" ? deliveryId.trim() : "";
  return occurrence ? `${identifier}\0${occurrence}` : identifier;
}

function clearNotificationResponseIfCurrent(response: Notifications.NotificationResponse): void {
  const last = Notifications.getLastNotificationResponse();
  const key = occurrenceKey(response);
  if (last && key && key === occurrenceKey(last)) Notifications.clearLastNotificationResponse();
}

/** The notification's login is not on this device; signing in to it opens the notification. */
export function promptNotificationSignIn(target: string): void {
  Alert.alert(t("Sign in to open this notification"), undefined, [
    { text: t("Cancel"), style: "cancel" },
    {
      text: t("Sign in"),
      onPress: () => {
        closeSettingsSheet();
        router.replace({
          pathname: "/sign-in",
          params: { mode: "in", addAccount: "1", notificationTarget: target },
        });
      },
    },
  ]);
}

export async function openNotificationResponse(
  response: Notifications.NotificationResponse | null | undefined,
): Promise<boolean> {
  if (!response) return false;
  const key = occurrenceKey(response);
  if (!key || openedResponses.has(key)) return false;
  const target = notificationResponseRoute(response, Notifications.DEFAULT_ACTION_IDENTIFIER);
  if (!target) return false;
  // Claim before the session read so a cold-start hook and the tap listener
  // cannot both open the same response.
  openedResponses.add(key);
  const attempt = ++openAttempt;
  try {
    const account = await selectNotificationAccount(target.params.userId, target.params.apiBase);
    if (attempt !== openAttempt) {
      openedResponses.delete(key);
      return false;
    }
    if (account !== "selected") {
      // Expo keeps this tap as the last response. Leaving it there would open
      // the thread on a later cold start, after sign-in, with no new tap.
      // A newer delivery can become last while this session read is in flight.
      clearNotificationResponseIfCurrent(response);
      openedResponses.delete(key);
      if (account === "signed-out") promptNotificationSignIn(notificationTargetLink(target));
      return false;
    }
    closeSettingsSheet();
    router.dismissTo("/");
    router.push(
      {
        ...target,
        params: {
          ...target.params,
          ...(target.params.apiBase ? { apiBase: currentApiBase() } : {}),
        },
      },
      { dangerouslySingular: threadRouteId },
    );
    clearNotificationResponseIfCurrent(response);
    return true;
  } catch {
    openedResponses.delete(key);
    return false;
  }
}

/** Opens the thread for a notification tap, including the tap that cold-started the app. */
export function useNotificationResponses(enabled: boolean): void {
  const lastResponse = Notifications.useLastNotificationResponse();

  useEffect(() => {
    if (!enabled) return;
    const subscription = Notifications.addNotificationResponseReceivedListener((response) => {
      void openNotificationResponse(response);
    });
    return () => subscription.remove();
  }, [enabled]);

  useEffect(() => {
    if (!enabled || !lastResponse) return;
    void openNotificationResponse(lastResponse);
  }, [enabled, lastResponse]);
}
