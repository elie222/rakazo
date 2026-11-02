import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
import { currentApiBase, loadSessionToken, rpc } from "./api";
import {
  pendingSessionTokens,
  retryPendingSessionRevocations,
} from "./pending-session-revocations";
import { loadSavedAccounts } from "./saved-accounts";

async function notificationsAllowed() {
  // On iOS getPermissionsAsync holds Expo's shared native queue until the system answers,
  // which can take minutes after a restart, and SecureStore waits behind it. The request
  // does not hold the queue and only prompts while the user hasn't chosen yet.
  if (Platform.OS === "ios") return (await Notifications.requestPermissionsAsync()).granted;
  const existing = await Notifications.getPermissionsAsync();
  return existing.granted || (await Notifications.requestPermissionsAsync()).granted;
}

export async function registerPushToken() {
  const apiBase = currentApiBase();
  // Revocation retries also run when permission is denied; they need no new push token.
  await retryPendingSessionRevocations(apiBase).catch(() => undefined);
  if (!(await notificationsAllowed())) return;
  try {
    const projectId = Constants.easConfig?.projectId ?? Constants.expoConfig?.extra?.eas?.projectId;
    if (!projectId) return;
    const token = (await Notifications.getExpoPushTokenAsync({ projectId })).data;
    if (!token) return;
    const accounts = await loadSavedAccounts(apiBase);
    const pending = await pendingSessionTokens(apiBase);
    const selectedToken = apiBase === currentApiBase() ? await loadSessionToken() : "";
    const activeToken = pending.has(selectedToken) ? "" : selectedToken;
    if (accounts.length === 0) {
      if (activeToken) await rpc("notifications/registerPush", { token });
    } else {
      const registering = accounts.map((account) =>
        rpc(
          "notifications/registerPush",
          { token },
          {
            requestContext: {
              apiBase,
              headers: {
                authorization: `Bearer ${account.token}`,
                "x-rakazo-user-id": account.userId,
              },
            },
          },
        ).catch(() => undefined),
      );
      if (activeToken && !accounts.some((account) => account.token === activeToken))
        registering.push(
          rpc(
            "notifications/registerPush",
            { token },
            {
              requestContext: { apiBase, headers: { authorization: `Bearer ${activeToken}` } },
            },
          ).catch(() => undefined),
        );
      await Promise.all(registering);
    }
  } catch {
    // Expo Go without an EAS project id and Android builds without a Firebase config
    // cannot mint an Expo push token.
  }
}

export async function unregisterPushToken() {
  await rpc("notifications/unregisterPush").catch(() => undefined);
}
