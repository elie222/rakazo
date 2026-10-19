import { formatTimeSeparator } from "@rakazo/core";
import { Text, View } from "react-native";
import { mobileTokens } from "../lib/appearance";
import { dateLocaleForUi, useI18n } from "../lib/i18n";

export function TimeSeparator({ createdAt }: { createdAt?: string }) {
  const { locale, t } = useI18n();
  if (!createdAt) return null;
  return (
    <Text
      accessibilityRole="header"
      selectable={false}
      style={{
        color: mobileTokens().mutedForeground,
        fontSize: 12,
        textAlign: "center",
        marginVertical: 12,
      }}
    >
      {formatTimeSeparator(createdAt, dateLocaleForUi(locale), {
        today: t("Today"),
        yesterday: t("Yesterday"),
      })}
    </Text>
  );
}

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
