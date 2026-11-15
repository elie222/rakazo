import { tokensForAppearance } from "@rakazo/ui-tokens";
import { lazy, Suspense } from "react";
import { Platform, Switch } from "react-native";
import { isComposeViewAvailable } from "../lib/compose-available";
import { useResolvedAppearance } from "../lib/native";
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
  const tokens = tokensForAppearance(useResolvedAppearance());
  const fallback = (
    <Switch
      accessibilityHint={accessibilityHint}
      accessibilityLabel={accessibilityLabel}
      disabled={disabled}
      onValueChange={onValueChange}
      thumbColor={thumbColor ?? (value ? tokens.primaryForeground : undefined)}
      trackColor={trackColor ?? { true: tintColor ?? tokens.primary }}
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
