import { ActivityIndicator, Pressable, Text } from "react-native";
import type { mobileTokens } from "../lib/appearance";
import { native, useMobileTokens } from "../lib/native";
import type { ActionProminence, NativeActionButtonProps } from "../lib/native-controls";
import { actionAccessibilityState, actionFills, actionProminence } from "../lib/native-controls";
import { NativeSymbol } from "./native-symbol";

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
  size = "default",
  icon,
  selected,
}: NativeActionButtonProps) {
  const tokens = useMobileTokens();
  const inactive = disabled || busy;
  const stretches = actionFills(prominence, fill);
  const small = size === "compact";
  const effectiveProminence = actionProminence(prominence, selected);
  const compact = prominence === "plain" || prominence === "quiet";
  const colors = buttonColors(effectiveProminence, stretches, tokens);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={actionAccessibilityState(inactive, selected)}
      disabled={inactive}
      hitSlop={compact ? 8 : undefined}
      onPress={onPress}
      style={({ pressed }) => [
        {
          flexDirection: "row",
          gap: icon && label ? 6 : undefined,
          minHeight: small || compact ? undefined : 48,
          borderRadius: 12,
          alignItems: "center",
          justifyContent: "center",
          alignSelf: stretches ? "stretch" : "flex-start",
          paddingHorizontal: small ? 6 : compact ? 0 : 16,
          paddingVertical: small ? 6 : compact ? 8 : 12,
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
        <>
          {icon ? (
            <NativeSymbol {...icon} size={icon.size ?? (small ? 16 : 18)} color={colors.label} />
          ) : null}
          {label ? (
            <Text
              style={{
                color: colors.label,
                fontSize: small
                  ? 13
                  : prominence === "quiet"
                    ? 15
                    : prominence === "plain"
                      ? 17
                      : 16,
                fontWeight: compact ? "400" : "600",
              }}
            >
              {label}
            </Text>
          ) : null}
        </>
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
