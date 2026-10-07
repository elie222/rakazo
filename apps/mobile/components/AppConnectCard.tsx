import type { MessageBlock } from "@rakazo/contracts";
import { abortableDelay } from "@rakazo/core";
import { useEffect, useRef, useState } from "react";
import type { ViewProps } from "react-native";
import { Linking, Text, View } from "react-native";
import { rpc } from "../lib/api";
import { appConnectPresentation } from "../lib/app-connect";
import { useI18n } from "../lib/i18n";
import { native, useMobileTokens } from "../lib/native";
import { errorText } from "../lib/user-error";
import { NativeActionButton } from "./native-action-button";

export function AppConnectCard({
  botId,
  block,
  accessibilityActions,
  onAccessibilityAction,
}: {
  botId: string;
  block: Extract<MessageBlock, { kind: "app_connect" }>;
  accessibilityActions?: ViewProps["accessibilityActions"];
  onAccessibilityAction?: ViewProps["onAccessibilityAction"];
}) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const [busy, setBusy] = useState(false);
  const [localStatus, setLocalStatus] = useState<"pending" | "connected">(block.status);
  const [error, setError] = useState<string | null>(null);
  const connectionAttempt = useRef<AbortController | null>(null);
  const status = block.status === "connected" ? "connected" : localStatus;
  const view = appConnectPresentation({ ...block, status }, busy);

  useEffect(() => () => connectionAttempt.current?.abort(), []);

  async function authorize() {
    connectionAttempt.current?.abort();
    const controller = new AbortController();
    connectionAttempt.current = controller;
    setBusy(true);
    setError(null);
    try {
      const started = await rpc<{ connectionId: string; authorizationUrl: string | null }>(
        "connections/begin",
        {
          connectorId: block.connectorId,
          provider: block.provider,
          displayName: block.name,
        },
        { signal: controller.signal },
      );
      if (controller.signal.aborted) return;
      if (started.authorizationUrl) await Linking.openURL(started.authorizationUrl);
      for (let attempt = 0; attempt < 60; attempt += 1) {
        if (controller.signal.aborted) return;
        const row = await rpc<{ status: string }>(
          "connections/complete",
          { connectionId: started.connectionId },
          { signal: controller.signal },
        ).catch(() => undefined);
        if (row?.status === "connected") {
          if (controller.signal.aborted) return;
          await rpc("onboarding/appConnected", {
            botId,
            provider: block.provider,
            connectorId: block.connectorId,
          });
          if (controller.signal.aborted) return;
          setLocalStatus("connected");
          return;
        }
        await abortableDelay(2_000, controller.signal);
      }
      if (!controller.signal.aborted) setError(t("Authorization timed out. Please try again."));
    } catch (reason) {
      if (!controller.signal.aborted) {
        setError(errorText(reason, t("Could not authorize this app")));
      }
    } finally {
      if (connectionAttempt.current === controller) {
        connectionAttempt.current = null;
        setBusy(false);
      }
    }
  }

  return (
    <View
      accessibilityLabel={t("{name} connection", { name: block.name })}
      style={{
        width: "90%",
        borderRadius: 18,
        backgroundColor: native.fill,
        paddingHorizontal: 16,
        paddingVertical: 14,
        gap: 8,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
        <View
          style={{
            width: 40,
            height: 40,
            borderRadius: 10,
            backgroundColor: native.fillPressed,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Text style={{ color: tokens.foreground, fontSize: 15, fontWeight: "600" }}>
            {block.name.slice(0, 1).toUpperCase()}
          </Text>
        </View>
        <View style={{ flex: 1, gap: 2 }}>
          <Text
            accessibilityActions={accessibilityActions}
            onAccessibilityAction={onAccessibilityAction}
            style={{ color: tokens.foreground, fontSize: 15, fontWeight: "600" }}
          >
            {view.title}
          </Text>
          <Text style={{ color: tokens.mutedForeground, fontSize: 13.5 }} numberOfLines={2}>
            {view.description}
          </Text>
        </View>
        {view.showAuthorize ? (
          <NativeActionButton
            label={view.actionLabel}
            accessibilityLabel={t("Authorize {name}", { name: block.name })}
            fill={false}
            busy={busy}
            style={{ alignSelf: "center" }}
            onPress={() => void authorize()}
          />
        ) : (
          <Text style={{ color: tokens.success, fontSize: 13.5, fontWeight: "600" }}>
            {view.actionLabel}
          </Text>
        )}
      </View>
      {error ? <Text style={{ color: tokens.destructive, fontSize: 13 }}>{error}</Text> : null}
    </View>
  );
}
