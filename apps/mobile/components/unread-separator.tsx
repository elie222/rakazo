import { Text, View } from "react-native";
import { useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";

export function UnreadSeparator() {
  const tokens = useMobileTokens();
  const { t } = useI18n();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 12, marginVertical: 12 }}>
      <View style={{ flex: 1, height: 1, backgroundColor: tokens.border }} />
      <Text accessibilityRole="header" style={{ color: tokens.foreground, fontSize: 12 }}>
        {t("New messages")}
      </Text>
      <View style={{ flex: 1, height: 1, backgroundColor: tokens.border }} />
    </View>
  );
}
