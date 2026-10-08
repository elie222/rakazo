import { Button, Host, ProgressView, Text } from "@expo/ui/swift-ui";
import {
  accessibilityLabel as accessibilityName,
  buttonStyle,
  controlSize,
  disabled as disable,
  foregroundStyle,
  frame,
  progressViewStyle,
  tint,
} from "@expo/ui/swift-ui/modifiers";
import { useMobileTokens, useResolvedAppearance } from "../lib/native";
import type { ActionProminence, NativeActionButtonProps } from "../lib/native-controls";
import { actionFills, iosAtLeast } from "../lib/native-controls";

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
}: NativeActionButtonProps) {
  const tokens = useMobileTokens();
  const scheme = useResolvedAppearance();
  const inactive = disabled || busy;
  const stretches = actionFills(prominence, fill);
  const role = prominence === "destructive" ? "destructive" : "default";
  const color =
    prominence === "destructive"
      ? tokens.destructive
      : prominence === "primary"
        ? tokens.primary
        : undefined;
  return (
    <Host
      colorScheme={scheme}
      ignoreSafeArea="container"
      matchContents={stretches ? { vertical: true } : true}
      style={[
        stretches ? { alignSelf: "stretch", minHeight: 48 } : { alignSelf: "flex-start" },
        style,
      ]}
    >
      <Button
        label={busy || stretches ? undefined : label}
        onPress={inactive ? undefined : onPress}
        role={role}
        modifiers={[
          buttonStyle(swiftStyle(prominence)),
          controlSize(stretches ? "large" : "regular"),
          disable(inactive),
          ...(color ? [tint(color)] : []),
          ...(busy || (accessibilityLabel && accessibilityLabel !== label)
            ? [accessibilityName(accessibilityLabel ?? label)]
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
        ) : stretches ? (
          <Text
            modifiers={[
              frame({ maxWidth: Infinity }),
              ...(!inactive && prominence === "primary"
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
  if (prominence === "plain") return glass ? "glass" : "plain";
  return glass ? "glass" : "bordered";
}
