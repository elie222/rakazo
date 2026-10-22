import { ActivityIndicator, Platform, Pressable, Text } from "react-native";
import type { mobileTokens } from "../lib/appearance";
import { native, useMobileTokens } from "../lib/native";
import type { ActionProminence, NativeActionButtonProps } from "../lib/native-controls";
import { actionAccessibilityState, actionFills, actionProminence } from "../lib/native-controls";
import { androidRipple, withAlpha } from "../lib/ripple";
import { NativeSymbol } from "./native-symbol";

/** Android (and non-iOS) form buttons. iOS uses the SwiftUI button in the platform file. */
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
  const inactive = disabled || busy;
  const stretches = actionFills(prominence, fill);
  const small = size === "compact";
  const effectiveProminence = actionProminence(prominence, selected);
  const compact = prominence === "plain" || prominence === "quiet";
  const colors =
    variant === "text"
      ? {
          background: "transparent",
          label: prominence === "destructive" ? tokens.destructive : tokens.link,
          border: undefined,
        }
      : variant === "rectangular"
        ? {
            background: effectiveProminence === "primary" ? tokens.primary : tokens.card,
            label: effectiveProminence === "primary" ? tokens.primaryForeground : tokens.foreground,
            border: effectiveProminence === "primary" ? tokens.primary : tokens.foreground,
          }
        : buttonColors(effectiveProminence, stretches, tokens);
  return (
    <Pressable
      accessibilityActions={accessibilityActions}
      onAccessibilityAction={onAccessibilityAction}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={actionAccessibilityState(inactive, selected)}
      disabled={inactive}
      hitSlop={compact ? 8 : undefined}
      android_ripple={androidRipple(withAlpha(colors.label, 0.2))}
      onPress={onPress}
      style={({ pressed }) => [
        {
          flexDirection: "row",
          gap: icon && label ? 6 : undefined,
          minHeight:
            variant === "rectangular" || (variant === "text" && prominence === "destructive")
              ? 44
              : variant === "text" || small || compact
                ? undefined
                : 48,
          borderRadius: variant === "rectangular" ? 9 : 12,
          alignItems: "center",
          justifyContent: "center",
          alignSelf: stretches ? "stretch" : "flex-start",
          paddingHorizontal:
            variant === "rectangular" ? 16 : variant === "text" ? 0 : small ? 6 : compact ? 0 : 16,
          paddingVertical:
            variant === "rectangular" ? 12 : variant === "text" ? 8 : small ? 6 : compact ? 8 : 12,
          backgroundColor: colors.background,
          borderWidth: colors.border ? 1 : 0,
          borderColor: colors.border,
          opacity: inactive ? 0.45 : pressed && Platform.OS !== "android" ? 0.7 : 1,
        },
        style,
        Platform.OS === "android" && { overflow: "hidden" },
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
                fontSize:
                  variant === "rectangular"
                    ? 15
                    : variant === "text"
                      ? 16
                      : small
                        ? 13
                        : prominence === "quiet"
                          ? 15
                          : prominence === "plain"
                            ? 17
                            : 16,
                fontWeight:
                  variant === "rectangular"
                    ? "600"
                    : variant === "text"
                      ? "500"
                      : compact
                        ? "400"
                        : "600",
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
      background: tokens.destructiveFill,
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
