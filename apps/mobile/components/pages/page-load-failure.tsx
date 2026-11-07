import { StyleSheet, Text, View } from "react-native";
import { useI18n } from "../../lib/i18n";
import { useMobileTokens } from "../../lib/native";
import { pageLoadProblem } from "../../lib/pages";
import { NativeActionButton } from "../native-action-button";

/**
 * A page or list that could not be read, said in the user's language with Try again; a page that
 * is gone (when `gone` names it) says so instead, as trying again cannot bring it back.
 */
export function PageLoadFailure({
  error,
  fallback,
  gone,
  onRetry,
}: {
  error: unknown;
  fallback: string;
  gone?: string;
  onRetry: () => void;
}) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const problem = pageLoadProblem(error);
  const message =
    problem === "gone" && gone
      ? gone
      : problem === "offline"
        ? t("Could not reach the server")
        : fallback;
  return (
    <View style={styles.failure}>
      <Text accessibilityRole="alert" style={[styles.message, { color: tokens.mutedForeground }]}>
        {message}
      </Text>
      {message === gone ? null : (
        <NativeActionButton label={t("Try again")} prominence="secondary" onPress={onRetry} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  failure: { alignItems: "center", gap: 12 },
  message: { fontSize: 15, textAlign: "center" },
});
