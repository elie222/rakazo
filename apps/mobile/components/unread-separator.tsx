import { Text, View } from "react-native";
import { mobileTokens } from "../lib/appearance";
import { useI18n } from "../lib/i18n";

export function UnreadSeparator() {
  const { t } = useI18n();
  const { border, mutedForeground } = mobileTokens();
  return (
    <View
      accessibilityRole="header"
      style={{ flexDirection: "row", alignItems: "center", gap: 12, marginVertical: 12 }}
    >
      <View style={{ flex: 1, height: 1, backgroundColor: border }} />
      <Text selectable={false} style={{ color: mutedForeground, fontSize: 12 }}>
        {t("New messages")}
      </Text>
      <View style={{ flex: 1, height: 1, backgroundColor: border }} />
    </View>
  );
}
