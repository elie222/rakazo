import { I18nManager, Platform } from "react-native";
import { native } from "../../lib/native/native";
import { NativeSymbol } from "../native/native-symbol";

/** Trailing disclosure chevron for list rows; points down while a section is expanded. */
export function Chevron({ expanded }: { expanded?: boolean }) {
  const androidForward =
    Platform.OS === "android" && I18nManager.isRTL ? "chevron-back" : "chevron-forward";
  return (
    <NativeSymbol
      android={expanded ? "chevron-down" : androidForward}
      color={native.tertiaryLabel}
      ios={expanded ? "chevron.down" : "chevron.right"}
      size={14}
    />
  );
}

/** Trailing mark on the selected row of a list. */
export function Checkmark() {
  return <NativeSymbol android="checkmark" color={native.label} ios="checkmark" size={16} />;
}
