import { Host, Text } from "@expo/ui/swift-ui";
import {
  dynamicTypeSize,
  font,
  frame,
  glassEffect,
  lineLimit,
  padding,
} from "@expo/ui/swift-ui/modifiers";
import { Text as RNText, StyleSheet, useWindowDimensions, View } from "react-native";
import { useResolvedAppearance } from "../lib/native";
import {
  HEADER_CONTROL_SIZE,
  HEADER_TITLE_MAX_FONT_SCALE,
  iosAtLeast,
} from "../lib/native-controls";

/**
 * Liquid Glass title capsule. The bar sizes its title view before SwiftUI measures,
 * so an invisible copy of the title gives the capsule its size on the first layout.
 */
export function GlassTitle({ title }: { title: string }) {
  const scheme = useResolvedAppearance();
  // Bar titles stay between the default text size and xxxLarge; the sizer must match the text.
  const { fontScale } = useWindowDimensions();
  const scale = Math.min(Math.max(fontScale, 1), HEADER_TITLE_MAX_FONT_SCALE);
  if (!title.trim()) return null;
  return (
    <View accessibilityLabel={title} accessibilityRole="header" accessible style={styles.frame}>
      <RNText
        allowFontScaling={false}
        numberOfLines={1}
        style={[styles.sizer, { fontSize: 17 * scale }]}
      >
        {title}
      </RNText>
      <Host colorScheme={scheme} style={StyleSheet.absoluteFill}>
        <Text
          modifiers={[
            font({ textStyle: "body", weight: "semibold" }),
            dynamicTypeSize({ min: "large", max: "xxxLarge" }),
            lineLimit(1),
            padding({ horizontal: 16 }),
            frame({ height: HEADER_CONTROL_SIZE }),
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
    height: HEADER_CONTROL_SIZE,
    paddingHorizontal: 16,
    justifyContent: "center",
  },
  sizer: {
    opacity: 0,
    fontWeight: "600",
  },
});
