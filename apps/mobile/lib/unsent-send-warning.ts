import { Alert } from "react-native";
import { t } from "./i18n";
import { hasUnsentSends } from "./thread-feedback";

/** What is about to clear the queue of unsent messages. */
export type UnsentSendLossAction = "sign-out" | "server-switch";

/**
 * Confirms an action that deletes this device's unsent messages. Resolves false when
 * messages wait and their owner keeps them, so the action must not run then.
 */
export function confirmUnsentSendLoss(action: UnsentSendLossAction): Promise<boolean> {
  if (!hasUnsentSends()) return Promise.resolve(true);
  const confirmLabel = action === "sign-out" ? t("Sign out anyway") : t("Switch anyway");
  const message =
    action === "sign-out"
      ? t("Signing out deletes unsent messages.")
      : t("Switching servers deletes unsent messages.");
  return new Promise((resolve) => {
    Alert.alert(t("Unsent messages"), message, [
      { text: t("Cancel"), style: "cancel", onPress: () => resolve(false) },
      { text: confirmLabel, style: "destructive", onPress: () => resolve(true) },
    ]);
  });
}
