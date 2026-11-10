import { lazy, Suspense } from "react";
import { Platform, Switch } from "react-native";
import { isComposeViewAvailable } from "../lib/compose-available";
import { systemGreen, useResolvedAppearance } from "../lib/native";
import type { NativeSwitchProps } from "../lib/native-controls";

// Do not evaluate Expo UI's native view adapters until the running binary supports them.
const ComposeSwitch = lazy(() => import("./native-switch-compose"));

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
  const scheme = useResolvedAppearance();
  const fallback = (
    <Switch
      accessibilityHint={accessibilityHint}
      accessibilityLabel={accessibilityLabel}
      disabled={disabled}
      onValueChange={onValueChange}
      thumbColor={thumbColor}
      trackColor={trackColor ?? { true: tintColor ?? systemGreen(scheme) }}
      value={value}
    />
  );
  if (
    Platform.OS !== "android" ||
    !isComposeViewAvailable("HostView") ||
    !isComposeViewAvailable("SwitchView")
  ) {
    return fallback;
  }
  return (
    <Suspense fallback={fallback}>
      <ComposeSwitch
        accessibilityHint={accessibilityHint}
        accessibilityLabel={accessibilityLabel}
        disabled={disabled}
        onValueChange={onValueChange}
        thumbColor={thumbColor}
        tintColor={tintColor}
        trackColor={trackColor}
        value={value}
      />
    </Suspense>
  );
}
