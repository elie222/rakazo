import { formatTimeSeparator } from "@rakazo/core";
import { Text } from "react-native";
import { mobileTokens } from "../lib/appearance";
import { dateLocaleForUi } from "../lib/i18n";

export function TimeSeparator({ createdAt }: { createdAt?: string }) {
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
      {formatTimeSeparator(createdAt, dateLocaleForUi())}
    </Text>
  );
}
