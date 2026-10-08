import { Host, Toggle } from "@expo/ui/swift-ui";
import {
  accessibilityHint,
  accessibilityLabel as accessibilityLabelModifier,
  disabled as disable,
  labelsHidden,
  tint,
  toggleStyle,
} from "@expo/ui/swift-ui/modifiers";
import { useResolvedAppearance } from "../lib/native";
import type { NativeSwitchProps } from "../lib/native-controls";

/** SwiftUI switch. The visible label stays in the surrounding row. */
export function NativeSwitch({
  value,
  onValueChange,
  disabled,
  accessibilityLabel,
  accessibilityHint: hint,
  tintColor,
}: NativeSwitchProps) {
  const scheme = useResolvedAppearance();
  return (
    <Host colorScheme={scheme} ignoreSafeArea="container" matchContents>
      <Toggle
        isOn={value}
        label={accessibilityLabel}
        onIsOnChange={onValueChange}
        modifiers={[
          toggleStyle("switch"),
          labelsHidden(),
          accessibilityLabelModifier(accessibilityLabel),
          ...(hint ? [accessibilityHint(hint)] : []),
          disable(Boolean(disabled)),
          ...(tintColor ? [tint(tintColor)] : []),
        ]}
      />
    </Host>
  );
}
