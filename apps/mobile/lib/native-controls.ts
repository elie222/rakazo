import type { ColorValue, StyleProp, ViewStyle } from "react-native";
import { Platform } from "react-native";

/** True on iOS at this major version or newer. Android and older iOS stay on the plain controls. */
export function iosAtLeast(major: number) {
  if (Platform.OS !== "ios") return false;
  const version = Platform.Version;
  const parsed = typeof version === "number" ? version : Number.parseFloat(version);
  return Number.isFinite(parsed) && parsed >= major;
}

export type ActionProminence = "primary" | "secondary" | "plain" | "quiet" | "destructive";

export type NativeActionButtonProps = {
  label: string;
  accessibilityLabel?: string;
  onPress: () => void;
  disabled?: boolean;
  /** Disables the control. Android shows a spinner; iOS keeps the label on a disabled native button. */
  busy?: boolean;
  prominence?: ActionProminence;
  /** Stretch to the container width. Defaults to true for primary and destructive. */
  fill?: boolean;
  style?: StyleProp<ViewStyle>;
};

export function actionFills(prominence: ActionProminence, fill: boolean | undefined) {
  if (fill !== undefined) return fill;
  return prominence === "primary" || prominence === "destructive";
}

export type NativeSwitchProps = {
  value: boolean;
  onValueChange: (value: boolean) => void;
  disabled?: boolean;
  accessibilityLabel: string;
  accessibilityHint?: string;
  /** Android track colors. Ignored by the iOS switch, which uses `tintColor`. */
  trackColor?: { false?: ColorValue; true?: ColorValue };
  /** Android thumb color. Ignored on iOS. */
  thumbColor?: ColorValue;
  /** iOS on-state tint. Omitted switches use the system tint. */
  tintColor?: ColorValue;
};

export type SegmentedOption<T extends string> = {
  value: T;
  label: string;
};

export type NativeSegmentedControlProps<T extends string> = {
  accessibilityLabel: string;
  value: T | undefined;
  onChange: (value: T) => void;
  options: readonly SegmentedOption<T>[];
  disabled?: boolean;
};
