import { Switch } from "react-native";
import type { NativeSwitchProps } from "../lib/native-controls";

/** Android switch. iOS uses a SwiftUI toggle. */
export function NativeSwitch({
  value,
  onValueChange,
  disabled,
  accessibilityLabel,
  accessibilityHint,
  trackColor,
  thumbColor,
  tintColor,
}: NativeSwitchProps) {
  return (
    <Switch
      accessibilityHint={accessibilityHint}
      accessibilityLabel={accessibilityLabel}
      disabled={disabled}
      onValueChange={onValueChange}
      thumbColor={thumbColor}
      trackColor={trackColor ?? (tintColor ? { true: tintColor } : undefined)}
      value={value}
    />
  );
}
