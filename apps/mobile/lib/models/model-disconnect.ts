import { ph, t } from "@lingui/core/macro";
import type { ModelDisconnectPreview } from "@rakazo/contracts";
import { modelDisconnectWarning } from "@rakazo/i18n/model-disconnect";
import { Alert } from "react-native";
import { rpc } from "../api/api";

/**
 * Asks before disconnecting a model connection, saying what goes with it. Native alerts cannot
 * update their message, so the preview is read before one opens; a preview that cannot be read
 * leaves the plain question, so Disconnect stays available.
 */
export async function confirmModelDisconnect(
  name: string,
  credential: { id: string; provider: string },
  onConfirm: () => void,
) {
  let preview: ModelDisconnectPreview | null = null;
  try {
    preview = await rpc("models/disconnectPreview", {
      provider: credential.provider,
      credentialId: credential.id,
    });
  } catch {
    preview = null;
  }
  const warning = modelDisconnectWarning(preview);
  const removes = t`This removes the connection from every space.`;
  Alert.alert(t`Disconnect ${ph({ name })}?`, warning ? `${removes} ${warning}` : removes, [
    { text: t`Cancel`, style: "cancel" },
    { text: t`Disconnect`, style: "destructive", onPress: onConfirm },
  ]);
}
