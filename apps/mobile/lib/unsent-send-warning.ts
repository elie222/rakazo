import { t } from "@lingui/core/macro";
import { Alert } from "react-native";
import { hasUnsentSends } from "./thread-feedback";
import { unsentSendsRestored } from "./unsent-sends";

/** What is about to clear the queue of unsent messages. */
export type UnsentSendLossAction = "sign-out" | "server-switch";

/**
 * Confirms an action that deletes this device's unsent messages. Resolves false when
 * messages wait and their owner keeps them, so the action must not run then.
 */
export async function confirmUnsentSendLoss(action: UnsentSendLossAction): Promise<boolean> {
  // The persisted queue loads asynchronously at startup; reading the in-memory list
  // before that lands, or after it failed, would treat an unknown queue as empty.
  if ((await unsentSendsRestored()) && !hasUnsentSends()) return true;
  const confirmLabel = action === "sign-out" ? t`Sign out anyway` : t`Switch anyway`;
  const message =
    action === "sign-out"
      ? t`Signing out deletes unsent messages.`
      : t`Switching servers deletes unsent messages.`;
  return new Promise((resolve) => {
    Alert.alert(t`Unsent messages`, message, [
      { text: t`Cancel`, style: "cancel", onPress: () => resolve(false) },
      { text: confirmLabel, style: "destructive", onPress: () => resolve(true) },
    ]);
  });
}
