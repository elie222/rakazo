import { Button, Host, Label, ProgressView, Text } from "@expo/ui/swift-ui";
import {
  accessibilityAddTraits,
  accessibilityHidden,
  accessibilityLabel as accessibilityName,
  accessibilityRemoveTraits,
  buttonStyle,
  controlSize,
  disabled as disable,
  font,
  foregroundStyle,
  frame,
  labelStyle,
  progressViewStyle,
  tint,
} from "@expo/ui/swift-ui/modifiers";
import { View } from "react-native";
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
  fill,
  style,
  size = "default",
  icon,
  selected,
}: NativeActionButtonProps) {
  const tokens = useMobileTokens();
  const scheme = useResolvedAppearance();
  const inactive = disabled || busy;
  const stretches = actionFills(prominence, fill);
  const small = size === "compact";
  const effectiveProminence = actionProminence(prominence, selected);
  const role = prominence === "destructive" ? "destructive" : "default";
  // The prominent styles draw a white label, which disappears on the light dark-mode primary.
  const filled = !inactive && effectiveProminence === "primary";
  const ownLabel = stretches || filled;
  const labelModifiers = [
    ...(stretches ? [frame({ maxWidth: Infinity, ...(small ? { minHeight: 16 } : {}) })] : []),
    ...(filled ? [foregroundStyle(tokens.primaryForeground)] : []),
  ];
  const color =
    effectiveProminence === "destructive"
      ? tokens.destructive
      : effectiveProminence === "primary"
        ? tokens.primary
        : undefined;
  const button = (
    <Host
      colorScheme={scheme}
      ignoreSafeArea="container"
      matchContents={stretches ? { vertical: true } : true}
      style={[
        stretches
          ? { alignSelf: "stretch", minHeight: small ? undefined : 48 }
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
          buttonStyle(swiftStyle(effectiveProminence)),
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
          ...(prominence === "quiet"
            ? [font({ size: 15 }), foregroundStyle(tokens.mutedForeground)]
            : []),
          disable(inactive),
          ...(color ? [tint(color)] : []),
          ...(busy || (accessibilityLabel && accessibilityLabel !== label)
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
