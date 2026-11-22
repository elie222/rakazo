import * as Notifications from "expo-notifications";
import { router, useNavigationContainerRef } from "expo-router";
import type { NavigationState, PartialState } from "expo-router/react-navigation";
import { CommonActions } from "expo-router/react-navigation";
import { useEffect } from "react";
import { loadSessionToken } from "../api/session";
import { closeSettingsSheet } from "../settings/settings-sheet";
import type { NotificationRoute } from "./notification-open";
import { notificationResponseRoute, threadRouteId } from "./notification-open";

const openedResponses = new Set<string>();

type NotificationNavigation = Pick<
  ReturnType<typeof useNavigationContainerRef>,
  "dispatch" | "getRootState"
>;

// Screens a notification may replace. Settings is closed for a notification either way.
const replaceableScreens = new Set(["index", "thread", "group-thread", "(settings)"]);

function findChatStack(root: NavigationState | undefined): NavigationState | undefined {
  let state: NavigationState | PartialState<NavigationState> | undefined = root;
  // Expo Router wraps the app's stack in its own root navigator.
  while (state?.stale === false) {
    if (state.type === "stack" && state.routeNames.includes("thread")) return state;
    state = state.routes[state.index]?.state;
  }
}

/** Opens the chat with the chat list under it, so Back returns to the list. Any other screen
 * in the stack (an editor, the share picker) stays, and the chat opens above it. */
function openNotificationThread(navigation: NotificationNavigation, target: NotificationRoute) {
  const stack = findChatStack(navigation.getRootState());
  if (!stack || stack.routes.some((route) => !replaceableScreens.has(route.name))) {
    closeSettingsSheet();
    router.push(target, {
      dangerouslySingular: threadRouteId,
      ...(!stack ? { withAnchor: true } : {}),
    });
    return;
  }

  const name = target.pathname.slice(1);
  const id = threadRouteId(name, target.params);
  const chat = stack.routes.findLast(
    (route) => route.name === name && threadRouteId(route.name, { ...route.params }) === id,
  );
  const inbox = stack.routes.find((route) => route.name === "index") ?? { name: "index" };
  // Keep the open chat's route key so a new delivery keeps the mounted screen and scroll.
  navigation.dispatch({
    ...CommonActions.reset({
      ...stack,
      index: 1,
      routes: [inbox, { ...chat, name, params: target.params }],
    }),
    target: stack.key,
  });
}

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

export async function openNotificationResponse(
  response: Notifications.NotificationResponse | null | undefined,
  navigation: NotificationNavigation,
): Promise<boolean> {
  if (!response) return false;
  const key = occurrenceKey(response);
  if (!key || openedResponses.has(key)) return false;
  const target = notificationResponseRoute(response, Notifications.DEFAULT_ACTION_IDENTIFIER);
  if (!target) return false;
  // Claim before the session read so a cold-start hook and the tap listener
  // cannot both open the same response.
  openedResponses.add(key);
  try {
    if (!(await loadSessionToken())) {
      // Expo keeps this tap as the last response. Leaving it there would open
      // the thread on a later cold start, after sign-in, with no new tap.
      // A newer delivery can become last while this session read is in flight.
      clearNotificationResponseIfCurrent(response);
      openedResponses.delete(key);
      return false;
    }
    openNotificationThread(navigation, target);
    clearNotificationResponseIfCurrent(response);
    return true;
  } catch {
    openedResponses.delete(key);
    return false;
  }
}

/** Opens the thread for a notification tap, including the tap that cold-started the app. */
export function useNotificationResponses(enabled: boolean): void {
  const navigation = useNavigationContainerRef();
  const lastResponse = Notifications.useLastNotificationResponse();

  useEffect(() => {
    if (!enabled) return;
    const subscription = Notifications.addNotificationResponseReceivedListener((response) => {
      void openNotificationResponse(response, navigation);
    });
    return () => subscription.remove();
  }, [enabled, navigation]);

  useEffect(() => {
    if (!enabled || !lastResponse) return;
    void openNotificationResponse(lastResponse, navigation);
  }, [enabled, lastResponse, navigation]);
}
