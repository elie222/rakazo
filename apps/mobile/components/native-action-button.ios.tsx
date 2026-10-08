import { Button, Host, Label, ProgressView, Text } from "@expo/ui/swift-ui";
import {
  accessibilityAddTraits,
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
import { useMobileTokens, useResolvedAppearance } from "../lib/native";
import type { ActionProminence, NativeActionButtonProps } from "../lib/native-controls";
import { actionFills, actionProminence, iosAtLeast } from "../lib/native-controls";

/** SwiftUI button. Glass styles need iOS 26; older iOS uses the bordered system styles. */
export function NativeActionButton({
  label,
  accessibilityLabel,
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
  const color =
    effectiveProminence === "destructive"
      ? tokens.destructive
      : effectiveProminence === "primary"
        ? tokens.primary
        : undefined;
  return (
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
        label={busy || stretches ? undefined : (label ?? accessibilityLabel)}
        systemImage={icon?.ios as never}
        onPress={inactive ? undefined : onPress}
        role={role}
        modifiers={[
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
        ) : stretches && icon ? (
          <Label
            title={label ?? accessibilityLabel}
            systemImage={icon.ios as never}
            modifiers={[
              frame({ maxWidth: Infinity, ...(small ? { minHeight: 16 } : {}) }),
              ...(!inactive && effectiveProminence === "primary"
                ? [foregroundStyle(tokens.primaryForeground)]
                : []),
            ]}
          />
        ) : stretches ? (
          <Text
            modifiers={[
              frame({ maxWidth: Infinity, ...(small ? { minHeight: 16 } : {}) }),
              ...(!inactive && effectiveProminence === "primary"
                ? [foregroundStyle(tokens.primaryForeground)]
                : []),
            ]}
          >
            {label}
          </Text>
        ) : undefined}
      </Button>
    </Host>
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
