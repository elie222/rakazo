import { useLingui } from "@lingui/react/macro";
import { formatTimeSeparator } from "@rakazo/core";
import { typeScale } from "@rakazo/ui-tokens";
import { Text } from "react-native";
import { mobileTokens } from "../lib/appearance";
import { dateLocaleForUi, useUiLocale } from "../lib/i18n";

export function TimeSeparator({ createdAt }: { createdAt?: string }) {
  const { t } = useLingui();
  const locale = useUiLocale();
  if (!createdAt) return null;
  return (
    <Text
      accessibilityRole="header"
      selectable={false}
      style={{
        color: mobileTokens().faintForeground,
        ...typeScale.caption,
        textAlign: "center",
        marginTop: 16,
        marginBottom: 4,
      }}
    >
      {formatTimeSeparator(createdAt, dateLocaleForUi(locale), {
        today: t`Today`,
        yesterday: t`Yesterday`,
      })}
    </Text>
  );
}
