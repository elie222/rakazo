import { Pressable } from "react-native";
import { mobileTokens } from "../lib/appearance";
import { t } from "../lib/i18n";
import { NativeSymbol } from "./native-symbol";

export function ReplyDismissButton({ onPress }: { onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t("Cancel reply")}
      onPress={onPress}
      hitSlop={8}
    >
      <NativeSymbol
        ios="xmark.circle.fill"
        android="close-circle"
        size={20}
        color={mobileTokens().mutedForeground}
      />
    </Pressable>
  );
}
