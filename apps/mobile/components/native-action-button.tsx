import { ActivityIndicator, Pressable, Text } from "react-native";
import type { mobileTokens } from "../lib/appearance";
import { native, useMobileTokens } from "../lib/native";
import type { ActionProminence, NativeActionButtonProps } from "../lib/native-controls";
import { actionFills } from "../lib/native-controls";

/** Android (and non-iOS) form buttons. iOS uses the SwiftUI button in the platform file. */
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
  const inactive = disabled || busy;
  const stretches = actionFills(prominence, fill);
  const compact = prominence === "plain" || prominence === "quiet";
  const colors = buttonColors(prominence, stretches, tokens);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={inactive ? { disabled: true } : undefined}
      disabled={inactive}
      hitSlop={compact ? 8 : undefined}
      onPress={onPress}
      style={({ pressed }) => [
        {
          minHeight: compact ? undefined : 48,
          borderRadius: 12,
          alignItems: "center",
          justifyContent: "center",
          alignSelf: stretches ? "stretch" : "flex-start",
          paddingHorizontal: compact ? 0 : 16,
          paddingVertical: compact ? 8 : 12,
          backgroundColor: colors.background,
          borderWidth: colors.border ? 1 : 0,
          borderColor: colors.border,
          opacity: inactive ? 0.45 : pressed ? 0.7 : 1,
        },
        style,
      ]}
    >
      {busy ? (
        <ActivityIndicator color={colors.label} />
      ) : (
        <Text
          style={{
            color: colors.label,
            fontSize: prominence === "quiet" ? 15 : prominence === "plain" ? 17 : 16,
            fontWeight: compact ? "400" : "600",
          }}
        >
          {label}
        </Text>
      )}
    </Pressable>
  );
}

function buttonColors(
  prominence: ActionProminence,
  fill: boolean,
  tokens: ReturnType<typeof mobileTokens>,
) {
  if (prominence === "primary") {
    return { background: tokens.primary, label: tokens.primaryForeground, border: undefined };
  }
  if (prominence === "destructive" && fill) {
    return {
      background: tokens.destructive,
      label: tokens.destructiveForeground,
      border: undefined,
    };
  }
  if (prominence === "destructive") {
    return { background: "transparent" as const, label: tokens.destructive, border: tokens.border };
  }
  if (prominence === "secondary") {
    return { background: "transparent" as const, label: native.label, border: tokens.border };
  }
  if (prominence === "quiet") {
    return { background: "transparent" as const, label: tokens.mutedForeground, border: undefined };
  }
  return { background: "transparent" as const, label: native.label, border: undefined };
}
