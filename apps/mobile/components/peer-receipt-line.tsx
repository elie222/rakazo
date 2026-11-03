import type { BotAvatarSet } from "@rakazo/contracts";
import { splitPeerLabel } from "@rakazo/core";
import type { PressableProps } from "react-native";
import { Pressable, StyleSheet, Text } from "react-native";
import { mobileTokens } from "../lib/appearance";
import { peerExchangeLabel, useI18n } from "../lib/i18n";
import { useThemedStyles } from "../lib/native";
import { BotAvatar } from "./bot-avatar";

export function PeerReceiptLine({
  peerBotId,
  peerBotName,
  color,
  avatarSet,
  count,
  direction,
  onPress,
  actionProps,
}: {
  peerBotId: string;
  peerBotName: string;
  color: string;
  avatarSet?: BotAvatarSet;
  count: number;
  direction: "sent" | "received";
  onPress?: () => void;
  actionProps: Pick<
    PressableProps,
    "onLongPress" | "accessibilityActions" | "onAccessibilityAction"
  >;
}) {
  useI18n();
  const styles = useThemedStyles(createStyles);
  const label = peerExchangeLabel(count, direction, peerBotName);
  const parts = splitPeerLabel(label, peerBotName);
  return (
    <Pressable
      {...actionProps}
      testID="peer-receipt-line"
      accessible
      accessibilityRole={onPress ? "button" : undefined}
      disabled={!onPress}
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => [styles.line, { opacity: pressed ? 0.6 : 1 }]}
    >
      {parts.before ? <Text style={styles.label}>{parts.before}</Text> : null}
      <BotAvatar avatarSet={avatarSet} color={color} identity={peerBotId} size={16} />
      {parts.name ? (
        <Text numberOfLines={1} style={[styles.label, styles.name]}>
          {parts.name}
        </Text>
      ) : null}
      {parts.after ? <Text style={styles.label}>{parts.after}</Text> : null}
    </Pressable>
  );
}

function createStyles() {
  const tokens = mobileTokens();
  return StyleSheet.create({
    line: {
      width: "100%",
      paddingVertical: 8,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 4,
    },
    label: { color: tokens.mutedForeground, fontSize: 13 },
    name: { fontWeight: "500", flexShrink: 1 },
  });
}
