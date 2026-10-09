import { GROUP_MEMBER_MAX } from "@rakazo/contracts";
import { StyleSheet, Text, View } from "react-native";
import type { MobileBot } from "../lib/api";
import { useMobileTokens } from "../lib/native";
import { BotAvatar } from "./bot-avatar";
import { NativeSwitch } from "./native-switch";

export function BotMemberPicker({
  bots,
  selected,
  onChange,
  disabled = false,
}: {
  bots: MobileBot[];
  selected: string[];
  onChange: (botIds: string[]) => void;
  disabled?: boolean;
}) {
  const tokens = useMobileTokens();
  return bots.map((bot) => {
    const checked = selected.includes(bot.id);
    return (
      <View key={bot.id} style={styles.row}>
        <BotAvatar color={bot.color} identity={bot.id} size={34} status={bot.status} />
        <Text style={[styles.name, { color: tokens.foreground }]}>{bot.name}</Text>
        <NativeSwitch
          accessibilityLabel={bot.name}
          disabled={disabled || (!checked && selected.length >= GROUP_MEMBER_MAX)}
          onValueChange={(next) => {
            if (next && selected.length >= GROUP_MEMBER_MAX) return;
            onChange(next ? [...selected, bot.id] : selected.filter((id) => id !== bot.id));
          }}
          thumbColor={checked ? tokens.primaryForeground : tokens.foreground}
          tintColor={tokens.primary}
          trackColor={{ false: tokens.border, true: tokens.primary }}
          value={checked}
        />
      </View>
    );
  });
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 12 },
  name: { flex: 1, fontSize: 16 },
});
