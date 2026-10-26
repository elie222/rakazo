import type { MessageBlock } from "@rakazo/contracts";
import { appConnectedInput, waitForConnection } from "@rakazo/core";
import { fontWeight, typeScale } from "@rakazo/ui-tokens";
import { useEffect, useRef, useState } from "react";
import type { ViewProps } from "react-native";
import { Linking, Text, View } from "react-native";
import { rpc } from "../lib/api";
import { appConnectPresentation } from "../lib/app-connect";
import { useI18n } from "../lib/i18n";
import { native, useMobileTokens } from "../lib/native";
import { useThreadReadOnly } from "../lib/thread-read-only";
import { errorText } from "../lib/user-error";
import { ConnectorIcon } from "./connector-icon";
import { NativeActionButton } from "./native-action-button";

export function AppConnectCard({
  botId,
  threadId,
  messageId,
  block,
  accessibilityActions,
  onAccessibilityAction,
}: {
  botId: string;
  threadId?: string;
  messageId?: string;
  block: Extract<MessageBlock, { kind: "app_connect" }>;
  accessibilityActions?: ViewProps["accessibilityActions"];
  onAccessibilityAction?: ViewProps["onAccessibilityAction"];
}) {
  const { t } = useI18n();
  const readOnly = useThreadReadOnly();
  const tokens = useMobileTokens();
  const [busy, setBusy] = useState(false);
  const [localStatus, setLocalStatus] = useState<"pending" | "connected">(block.status);
  const [error, setError] = useState<string | null>(null);
  const connectionAttempt = useRef<AbortController | null>(null);
  const status = block.status === "connected" ? "connected" : localStatus;
  const view = appConnectPresentation({ ...block, status }, busy);

  useEffect(() => () => connectionAttempt.current?.abort(), []);

  async function authorize() {
    if (readOnly || !threadId) return;
    connectionAttempt.current?.abort();
    const controller = new AbortController();
    connectionAttempt.current = controller;
    setBusy(true);
    setError(null);
    try {
      const started = await rpc(
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
      const result = await waitForConnection(
        started.connectionId,
        (input) => rpc("connections/complete", input, { signal: controller.signal }),
        { signal: controller.signal, attempts: 60 },
      );
      if (result.status === "aborted") return;
      if (result.status === "connected") {
        await rpc("onboarding/appConnected", appConnectedInput(botId, threadId, block, messageId));
        if (controller.signal.aborted) return;
        setLocalStatus("connected");
        return;
      }
      setError(t("Authorization timed out. Please try again."));
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
        width: "100%",
        borderRadius: 18,
        backgroundColor: native.fill,
        paddingHorizontal: 16,
        paddingVertical: 14,
        gap: 8,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
        <ConnectorIcon name={block.name} logo={block.logo} size={40} />
        <View style={{ flex: 1, gap: 2 }}>
          <Text
            accessibilityActions={accessibilityActions}
            onAccessibilityAction={onAccessibilityAction}
            style={{ color: tokens.foreground, ...typeScale.cardTitle }}
          >
            {view.title}
          </Text>
          <Text style={{ color: tokens.mutedForeground, ...typeScale.secondary }} numberOfLines={1}>
            {view.description}
          </Text>
        </View>
        {view.showAuthorize && !readOnly && threadId ? (
          <NativeActionButton
            label={view.actionLabel}
            accessibilityLabel={t("Authorize {name}", { name: block.name })}
            fill={false}
            busy={busy}
            style={{ alignSelf: "center" }}
            onPress={() => void authorize()}
          />
        ) : !view.showAuthorize ? (
          <Text
            style={{ color: tokens.success, ...typeScale.secondary, fontWeight: fontWeight.medium }}
          >
            {view.actionLabel}
          </Text>
        ) : null}
      </View>
      {error ? (
        <Text style={{ color: tokens.destructive, ...typeScale.caption }}>{error}</Text>
      ) : null}
    </View>
  );
}
