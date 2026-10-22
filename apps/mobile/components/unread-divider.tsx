import { fontWeight, typeScale } from "@rakazo/ui-tokens";
import { StyleSheet, Text, View } from "react-native";
import { useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";

/** Marks where the messages the user hadn't seen yet begin. */
export function UnreadDivider({ afterSeparator = false }: { afterSeparator?: boolean }) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const line = [styles.line, { backgroundColor: tokens.unread }];
  return (
    <View
      accessibilityLabel={t("New messages")}
      accessible
      style={[styles.row, afterSeparator && { paddingTop: 0 }]}
    >
      <View style={line} />
      <Text style={[styles.label, { color: tokens.unread }]}>{t("New")}</Text>
      <View style={line} />
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 10, paddingTop: 14, paddingBottom: 8 },
  line: { flex: 1, height: 1, opacity: 0.5 },
  label: {
    ...typeScale.footnote,
    fontWeight: fontWeight.semibold,
    letterSpacing: 0.5,
    textTransform: "uppercase",
  },
});
