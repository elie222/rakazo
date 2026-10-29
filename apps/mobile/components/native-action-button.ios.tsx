import { Button, Host, Label, ProgressView, Text } from "@expo/ui/swift-ui";
import {
  accessibilityAddTraits,
  accessibilityHidden,
  accessibilityLabel as accessibilityName,
  accessibilityRemoveTraits,
  background,
  buttonStyle,
  controlSize,
  disabled as disable,
  fixedSize,
  font,
  foregroundStyle,
  frame,
  labelStyle,
  padding,
  progressViewStyle,
  shapes,
  strokeBorder,
  tint,
} from "@expo/ui/swift-ui/modifiers";
import { StyleSheet, useWindowDimensions, View } from "react-native";
import { useMobileTokens, useResolvedAppearance } from "../lib/native";
import type { ActionProminence, NativeActionButtonProps } from "../lib/native-controls";
import { actionFills, actionProminence, iosAtLeast } from "../lib/native-controls";

/** SwiftUI button. Glass styles need iOS 26; older iOS uses the bordered system styles. */
export function NativeActionButton({
  label,
  accessibilityLabel,
  accessibilityActions,
  onAccessibilityAction,
  onPress,
  disabled = false,
  busy = false,
  prominence = "primary",
  variant,
  fill,
  style,
  size = "default",
  icon,
  selected,
}: NativeActionButtonProps) {
  const tokens = useMobileTokens();
  const { fontScale } = useWindowDimensions();
  const scheme = useResolvedAppearance();
  const inactive = disabled || busy;
  const stretches = actionFills(prominence, fill);
  const small = size === "compact";
  const effectiveProminence = actionProminence(prominence, selected);
  const role = prominence === "destructive" ? "destructive" : "default";
  // The prominent styles draw a white label, which disappears on the light dark-mode primary.
  const filled = !inactive && effectiveProminence === "primary";
  const ownLabel = stretches || filled || variant !== undefined;
  const rectangular = variant === "rectangular";
  const measuredWidth = StyleSheet.flatten(style)?.width;
  const primary = effectiveProminence === "primary";
  const labelModifiers = variant
    ? [
        font({
          ...(rectangular ? { size: 15 * fontScale } : { textStyle: "callout" as const }),
          weight: rectangular ? "semibold" : "medium",
        }),
        foregroundStyle(
          rectangular
            ? primary
              ? tokens.primaryForeground
              : tokens.foreground
            : prominence === "destructive"
              ? tokens.destructive
              : tokens.link,
        ),
        ...(rectangular ? [fixedSize({ horizontal: false, vertical: true })] : []),
        padding({ horizontal: rectangular ? 16 : 0, vertical: rectangular ? 12 : 8 }),
        ...(stretches
          ? [
              frame(
                typeof measuredWidth === "number"
                  ? { width: measuredWidth }
                  : { maxWidth: Infinity },
              ),
            ]
          : []),
        // Rectangular buttons and the destructive text action (Disconnect) keep a 44pt target.
        ...(rectangular || prominence === "destructive" ? [frame({ minHeight: 44 })] : []),
        ...(rectangular
          ? [
              background(
                primary ? tokens.primary : tokens.card,
                shapes.roundedRectangle({ cornerRadius: 9 }),
              ),
              strokeBorder({
                content: primary ? tokens.primary : tokens.foreground,
                shape: "roundedRectangle",
                cornerRadius: 9,
                style: { lineWidth: 1 },
              }),
            ]
          : []),
      ]
    : [
        ...(stretches ? [frame({ maxWidth: Infinity, ...(small ? { minHeight: 16 } : {}) })] : []),
        ...(filled ? [foregroundStyle(tokens.primaryForeground)] : []),
      ];
  // Destructive buttons use the prominent style, which fills with the tint under a white
  // label; the text-red `destructive` is too pale for that in dark mode.
  const color =
    effectiveProminence === "destructive"
      ? variant
        ? tokens.destructive
        : tokens.destructiveFill
      : effectiveProminence === "primary"
        ? tokens.primary
        : undefined;
  const button = (
    <Host
      // Expo UI reads matchContents only on mount. Wrapping changes which axis Yoga owns.
      key={stretches ? "fill" : "intrinsic"}
      colorScheme={scheme}
      ignoreSafeArea="container"
      matchContents={stretches ? { vertical: true } : true}
      style={[
        stretches
          ? { alignSelf: "stretch", minHeight: rectangular ? 44 : small ? undefined : 48 }
          : { alignSelf: "flex-start" },
        style,
      ]}
    >
      <Button
        label={busy || ownLabel ? undefined : (label ?? accessibilityLabel)}
        systemImage={icon?.ios as never}
        onPress={inactive ? undefined : onPress}
        role={role}
        modifiers={[
          ...(accessibilityActions?.length ? [accessibilityHidden(true)] : []),
          buttonStyle(variant ? "plain" : swiftStyle(effectiveProminence)),
          ...(rectangular && stretches ? [frame({ maxWidth: Infinity })] : []),
          controlSize(
            small ? "small" : stretches ? "large" : prominence === "quiet" ? "small" : "regular",
          ),
          ...(small ? [font({ size: 13 })] : []),
          ...(icon && !label ? [labelStyle("iconOnly")] : []),
          ...(selected === undefined
            ? []
            : [
                selected
                  ? accessibilityAddTraits(["isSelected"])
                  : accessibilityRemoveTraits(["isSelected"]),
              ]),
          ...(!variant && prominence === "quiet"
            ? [font({ size: 15 }), foregroundStyle(tokens.mutedForeground)]
            : []),
          disable(inactive),
          ...(color ? [tint(color)] : []),
          ...(variant || busy || (accessibilityLabel && accessibilityLabel !== label)
            ? [accessibilityName(accessibilityLabel ?? label ?? "")]
            : []),
        ]}
      >
        {busy ? (
          <ProgressView
            modifiers={[
              progressViewStyle("circular"),
              ...(stretches ? [frame({ maxWidth: Infinity })] : []),
            ]}
          />
        ) : ownLabel && icon ? (
          <Label
            title={label ?? accessibilityLabel}
            systemImage={icon.ios as never}
            modifiers={labelModifiers}
          />
        ) : ownLabel ? (
          <Text modifiers={labelModifiers}>{label}</Text>
        ) : undefined}
      </Button>
    </Host>
  );
  // Expo UI does not expose SwiftUI custom accessibility actions. Give the native
  // control one React Native accessibility element with the same activation and menu.
  return accessibilityActions?.length ? (
    <View
      accessible
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: inactive, ...(selected === undefined ? {} : { selected }) }}
      accessibilityActions={accessibilityActions}
      onAccessibilityAction={onAccessibilityAction}
      onAccessibilityTap={inactive ? undefined : onPress}
    >
      {button}
    </View>
  ) : (
    button
  );
}

function swiftStyle(prominence: ActionProminence) {
  const glass = iosAtLeast(26);
  if (prominence === "primary" || prominence === "destructive") {
    return glass ? "glassProminent" : "borderedProminent";
  }
  if (prominence === "quiet") return "plain";
  if (prominence === "plain") return glass ? "glass" : "plain";
  return glass ? "glass" : "bordered";
}
