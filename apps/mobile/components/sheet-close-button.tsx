import { Pressable } from "react-native";
import { useI18n } from "../lib/i18n";
import { native } from "../lib/native";
import { NativeSymbol } from "./native-symbol";

export function SheetCloseButton({ onPress }: { onPress: () => void }) {
  const { t } = useI18n();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t("Close")}
      onPress={onPress}
      hitSlop={7}
      style={{
        width: 30,
        height: 30,
        borderRadius: 15,
        backgroundColor: native.fillPressed,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <NativeSymbol ios="xmark" android="close" size={13} color={native.secondaryLabel} />
    </Pressable>
  );
}
