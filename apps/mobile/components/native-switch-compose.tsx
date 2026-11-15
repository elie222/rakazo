import { Host, Switch } from "@expo/ui/jetpack-compose";
import { alpha } from "@expo/ui/jetpack-compose/modifiers";
import { tokensForAppearance } from "@rakazo/ui-tokens";
import { Pressable, View } from "react-native";
import { useResolvedAppearance } from "../lib/native";
import type { NativeSwitchProps } from "../lib/native-controls";

/** Loaded only when the running Android binary has the Compose host and switch. */
export default function ComposeSwitch({
  value,
  onValueChange,
  disabled,
  accessibilityLabel,
  accessibilityHint,
  trackColor,
  thumbColor,
  tintColor,
}: NativeSwitchProps) {
  const scheme = useResolvedAppearance();
  const tokens = tokensForAppearance(scheme);
  // Material 3 in the app's monochrome: an on switch is the ink with a page-coloured thumb.
  const checkedTrack = trackColor?.true ?? tintColor ?? tokens.primary;
  const checkedThumb = thumbColor ?? tokens.primaryForeground;
  const uncheckedTrack = trackColor?.false ?? tokens.secondary;
  const uncheckedBorder = scheme === "light" ? tokens.ring : "transparent";
  // Material 3: an unchecked thumb in the outline colour, so it reads on the light track.
  const uncheckedThumb = thumbColor ?? (scheme === "dark" ? tokens.mutedForeground : tokens.ring);

  return (
    // Expo UI's description modifier exposes a separate node from Material's toggle state.
    // Own one accessible switch and hide Compose descendants from accessibility services.
    <Pressable
      accessible
      accessibilityRole="switch"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ checked: value, disabled: !!disabled }}
      disabled={disabled}
      onPress={disabled ? undefined : () => onValueChange(!value)}
      style={{ flexShrink: 0 }}
    >
      <View importantForAccessibility="no-hide-descendants" pointerEvents="none">
        {/* Leave room for track rounding without increasing the row's height. */}
        <Host colorScheme={scheme} style={{ width: 56, height: 32, flexShrink: 0 }}>
          <Switch
            // SwitchContent reads props.value directly; SyncSwitch mutates native state first.
            value={value}
            enabled={!disabled}
            colors={{
              checkedTrackColor: checkedTrack,
              checkedThumbColor: checkedThumb,
              checkedBorderColor: "transparent",
              uncheckedTrackColor: uncheckedTrack,
              uncheckedThumbColor: uncheckedThumb,
              uncheckedBorderColor: uncheckedBorder,
              disabledCheckedTrackColor: checkedTrack,
              disabledCheckedThumbColor: checkedThumb,
              disabledCheckedBorderColor: "transparent",
              disabledUncheckedTrackColor: uncheckedTrack,
              disabledUncheckedThumbColor: uncheckedThumb,
              disabledUncheckedBorderColor: uncheckedBorder,
            }}
            modifiers={[alpha(disabled ? 0.38 : 1)]}
          />
        </Host>
      </View>
    </Pressable>
  );
}
