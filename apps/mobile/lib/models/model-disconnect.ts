import { ph, t } from "@lingui/core/macro";
import type { ModelDisconnectPreview } from "@rakazo/contracts";
import { modelDisconnectWarning } from "@rakazo/i18n/model-disconnect";
import { useCallback, useEffect, useRef } from "react";
import { Alert } from "react-native";
import { rpc } from "../api/api";

/**
 * Whether the component that asked is still there, for `confirmModelDisconnect`'s `current`: a
 * question prepared after it has gone must not open over another screen.
 */
export function useStillShown(): () => boolean {
  const shown = useRef(true);
  useEffect(() => {
    shown.current = true;
    return () => {
      shown.current = false;
    };
  }, []);
  return useCallback(() => shown.current, []);
}

/** Connections whose question is being prepared, so a second tap does not open a second one. */
const asking = new Set<string>();

/**
 * Asks before disconnecting a model connection, saying what goes with it. Native alerts cannot
 * update their message, so the preview is read before one opens; a preview that cannot be read
 * leaves the plain question, so Disconnect stays available. `current` is false once the screen
 * that asked has gone, so a late answer does not open the question elsewhere.
 */
export async function confirmModelDisconnect(
  name: string,
  credential: { id: string; provider: string },
  onConfirm: () => void,
  current: () => boolean = () => true,
) {
  if (asking.has(credential.id)) return;
  asking.add(credential.id);
  let preview: ModelDisconnectPreview | null = null;
  try {
    preview = await rpc("models/disconnectPreview", {
      provider: credential.provider,
      credentialId: credential.id,
    });
  } catch {
    preview = null;
  } finally {
    asking.delete(credential.id);
  }
  if (!current()) return;
  const warning = modelDisconnectWarning(preview);
  const removes = t`This removes the connection from every space.`;
  Alert.alert(t`Disconnect ${ph({ name })}?`, warning ? `${removes} ${warning}` : removes, [
    { text: t`Cancel`, style: "cancel" },
    { text: t`Disconnect`, style: "destructive", onPress: onConfirm },
  ]);
}
