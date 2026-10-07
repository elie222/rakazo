import { Pressable, Text } from "react-native";
import { native } from "../lib/native";
import { iosAtLeast } from "../lib/native-controls";

/**
 * iOS 26 wraps a custom header view in a Liquid Glass capsule and lays the
 * label out from the leading edge, so text such as "Cancel" clips. A native
 * bar-button item lets the system size that capsule and center the label.
 * Android and older iOS keep the plain text button.
 */
function HeaderTextButton({
  label,
  onPress,
  disabled,
  emphasis,
  edge,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  emphasis?: boolean;
  edge: "leading" | "trailing";
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={disabled ? { disabled: true } : undefined}
      disabled={disabled}
      hitSlop={8}
      onPress={onPress}
      style={{
        backgroundColor: "transparent",
        paddingVertical: 8,
        paddingStart: edge === "trailing" ? 20 : 0,
        paddingEnd: edge === "leading" ? 20 : 0,
        justifyContent: "center",
        opacity: disabled ? 0.4 : 1,
      }}
    >
      <Text
        style={{
          color: native.label,
          fontSize: 17,
          fontWeight: emphasis ? "600" : "400",
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

function nativeHeaderItems() {
  return iosAtLeast(26);
}

export function cancelHeaderOptions(label: string, onPress: () => void) {
  return {
    headerBackVisible: false as const,
    headerLeft: () => <HeaderTextButton edge="leading" label={label} onPress={onPress} />,
    ...(nativeHeaderItems()
      ? {
          unstable_headerLeftItems: () => [
            {
              type: "button" as const,
              label,
              variant: "plain" as const,
              onPress,
            },
          ],
        }
      : {}),
  };
}

export function trailingHeaderOptions(label: string, onPress: () => void, disabled = false) {
  return {
    headerRight: () => (
      <HeaderTextButton
        disabled={disabled}
        edge="trailing"
        emphasis
        label={label}
        onPress={onPress}
      />
    ),
    ...(nativeHeaderItems()
      ? {
          unstable_headerRightItems: () => [
            {
              type: "button" as const,
              label,
              variant: "done" as const,
              tintColor: native.label,
              disabled,
              onPress,
            },
          ],
        }
      : {}),
  };
}
