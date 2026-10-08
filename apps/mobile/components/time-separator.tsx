import { formatTimeSeparator } from "@rakazo/core";
import { Text } from "react-native";
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
