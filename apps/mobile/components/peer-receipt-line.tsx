import { splitPeerLabel } from "@rakazo/core";
import type { PressableProps } from "react-native";
import { Pressable, Text } from "react-native";
import { peerExchangeLabel, useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";
import { BotAvatar } from "./bot-avatar";

export function PeerReceiptLine({
  peerBotId,
  peerBotName,
  color,
  count,
  direction,
  onPress,
  actionProps,
}: {
  peerBotId: string;
  peerBotName: string;
  color: string;
  count: number;
  direction: "sent" | "received";
  onPress: () => void;
  actionProps: Pick<
    PressableProps,
    "onLongPress" | "accessibilityActions" | "onAccessibilityAction"
  >;
}) {
  useI18n();
  const tokens = useMobileTokens();
  const label = peerExchangeLabel(count, direction, peerBotName);
  const parts = splitPeerLabel(label, peerBotName);
  return (
    <Pressable
      {...actionProps}
      testID="peer-receipt-line"
      accessible
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => ({
        width: "100%",
        paddingVertical: 8,
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: 4,
        opacity: pressed ? 0.6 : 1,
      })}
    >
      {parts.before ? (
        <Text style={{ color: tokens.mutedForeground, fontSize: 13 }}>{parts.before}</Text>
      ) : null}
      <BotAvatar color={color} identity={peerBotId} size={16} />
      {parts.name ? (
        <Text
          numberOfLines={1}
          style={{ color: tokens.mutedForeground, fontSize: 13, fontWeight: "500", flexShrink: 1 }}
        >
          {parts.name}
        </Text>
      ) : null}
      {parts.after ? (
        <Text style={{ color: tokens.mutedForeground, fontSize: 13 }}>{parts.after}</Text>
      ) : null}
    </Pressable>
  );
}
