import { Text, View } from "react-native";
import { mobileTokens } from "../lib/appearance";
import { useI18n } from "../lib/i18n";
import { NativeActionButton } from "./native-action-button";

/** A failed first load of a settings screen, with the way to try it again. */
export function LoadFailure({ message, onRetry }: { message: string; onRetry: () => void }) {
  const { t } = useI18n();
  return (
    <View style={{ gap: 8 }}>
      <Text accessibilityRole="alert" style={{ color: mobileTokens().destructive, fontSize: 14 }}>
        {message}
      </Text>
      <NativeActionButton
        label={t("Retry")}
        fill={false}
        prominence="secondary"
        onPress={onRetry}
      />
    </View>
  );
}
