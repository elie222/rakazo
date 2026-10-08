import { Host, Text } from "@expo/ui/swift-ui";
import { font, glassEffect, lineLimit, padding } from "@expo/ui/swift-ui/modifiers";
import { Text as RNText, StyleSheet, View } from "react-native";
import { useResolvedAppearance } from "../lib/native";
import { iosAtLeast } from "../lib/native-controls";

/**
 * Liquid Glass title capsule. The bar sizes its title view before SwiftUI measures,
 * so an invisible copy of the title gives the capsule its size on the first layout.
 */
export function GlassTitle({ title }: { title: string }) {
  const scheme = useResolvedAppearance();
  return (
    <View accessibilityLabel={title} accessibilityRole="header" accessible style={styles.frame}>
      <RNText numberOfLines={1} style={styles.sizer}>
        {title}
      </RNText>
      <Host colorScheme={scheme} style={StyleSheet.absoluteFill}>
        <Text
          modifiers={[
            font({ size: 17, weight: "semibold" }),
            lineLimit(1),
            padding({ horizontal: 16, vertical: 11 }),
            glassEffect({ glass: { variant: "regular" }, shape: "capsule" }),
          ]}
        >
          {title}
        </Text>
      </Host>
    </View>
  );
}

export function floatingHeaderOptions() {
  if (!iosAtLeast(26)) return {};
  return {
    headerTransparent: true,
    headerStyle: { backgroundColor: "transparent" },
    headerTitle: ({ children }: { children: string }) => <GlassTitle title={children} />,
  };
}

export function glassHeaderOptions(title: string) {
  return { ...floatingHeaderOptions(), title };
}

const styles = StyleSheet.create({
  frame: {
    maxWidth: 240,
    height: 44,
    paddingHorizontal: 16,
    justifyContent: "center",
  },
  sizer: {
    opacity: 0,
    fontSize: 17,
    fontWeight: "600",
  },
});
