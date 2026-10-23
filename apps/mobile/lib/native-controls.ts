import type { ComponentProps } from "react";
import type { ColorValue, StyleProp, ViewProps, ViewStyle } from "react-native";
import { Platform } from "react-native";
import type { NativeSymbol } from "../components/native-symbol";

/** True on iOS at this major version or newer. Android and older iOS stay on the plain controls. */
export function iosAtLeast(major: number) {
  if (Platform.OS !== "ios") return false;
  const version = Platform.Version;
  const parsed = typeof version === "number" ? version : Number.parseFloat(version);
  return Number.isFinite(parsed) && parsed >= major;
}

/** Height of an iOS 26 glass bar button; custom header titles match it. */
export const HEADER_CONTROL_SIZE = 44;
/** Header titles stop growing at Dynamic Type xxxLarge so they keep that height. */
export const HEADER_TITLE_MAX_FONT_SCALE = 1.35;

export type ActionProminence = "primary" | "secondary" | "plain" | "quiet" | "destructive";

export type NativeActionButtonProps = {
  accessibilityActions?: ViewProps["accessibilityActions"];
  onAccessibilityAction?: ViewProps["onAccessibilityAction"];
  onPress: () => void;
  disabled?: boolean;
  /** Disables the control. Android shows a spinner; iOS keeps the label on a disabled native button. */
  busy?: boolean;
  prominence?: ActionProminence;
  /** Flat recovery controls and text actions, without native glass styling. */
  variant?: "rectangular" | "text";
  /** Small native control, without the default filled button minimum height. */
  size?: "default" | "compact";
  /** Optional latched state; false is regular, true is prominent. */
  selected?: boolean;
  /** Stretch to the container width. Defaults to true for primary and destructive. */
  fill?: boolean;
  style?: StyleProp<ViewStyle>;
} & (
  | { label: string; accessibilityLabel?: string; icon?: ComponentProps<typeof NativeSymbol> }
  | { label?: never; accessibilityLabel: string; icon: ComponentProps<typeof NativeSymbol> }
);

export function actionProminence(prominence: ActionProminence, selected: boolean | undefined) {
  return selected === undefined ? prominence : selected ? "primary" : "secondary";
}

export function actionAccessibilityState(inactive: boolean, selected: boolean | undefined) {
  if (!inactive && selected === undefined) return undefined;
  return {
    ...(inactive ? { disabled: true } : {}),
    ...(selected === undefined ? {} : { selected }),
  };
}

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
  /** Android track colors. Defaults the ON track to system green and OFF to platform grey. Ignored on iOS. */
  trackColor?: { false?: ColorValue; true?: ColorValue };
  /** Android thumb color. Ignored on iOS. */
  thumbColor?: ColorValue;
  /** On-state tint (also the Android track fallback). iOS uses system green by default. */
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
