import { ph, t } from "@lingui/core/macro";
import { modelDisconnectWarning } from "@rakazo/i18n/model-disconnect";
import { bestEffort } from "@rakazo/logging/best-effort";
import { useFocusEffect } from "expo-router";
import { useCallback, useRef } from "react";
import { Alert } from "react-native";
import { rpc } from "../api/api";
import { currentSessionGeneration } from "../api/session";

/** Prepares one native confirmation at a time and cancels it when the screen loses focus. */
export function useConfirmModelDisconnect() {
  const active = useRef<AbortController | null>(null);
  useFocusEffect(
    useCallback(
      () => () => {
        active.current?.abort();
        active.current = null;
      },
      [],
    ),
  );

  return async (
    name: string,
    credential: { id: string; provider: string },
    onConfirm: () => void,
  ) => {
    if (active.current) return;
    const request = new AbortController();
    active.current = request;
    const generation = currentSessionGeneration();
    const current = () => !request.signal.aborted && generation === currentSessionGeneration();
    const finish = () => {
      if (active.current === request) active.current = null;
    };
    const preview = await bestEffort(
      "read model disconnect preview",
      rpc(
        "models/disconnectPreview",
        { provider: credential.provider, credentialId: credential.id },
        { signal: request.signal },
      ),
    );
    if (!current()) {
      finish();
      return;
    }
    const warning = modelDisconnectWarning(preview ?? null);
    const removes = t`This removes the connection from every space.`;
    Alert.alert(
      t`Disconnect ${ph({ name })}?`,
      [removes, warning].filter(Boolean).join("\n\n"),
      [
        { text: t`Cancel`, style: "cancel", onPress: finish },
        {
          text: t`Disconnect`,
          style: "destructive",
          onPress: () => {
            finish();
            if (current()) onConfirm();
          },
        },
      ],
      { onDismiss: finish },
    );
  };
}
