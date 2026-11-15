import { MenuView } from "@expo/ui/community/menu";
import { useLingui } from "@lingui/react/macro";
import { useRouter } from "expo-router";
import type { ReactNode } from "react";
import { Platform, Pressable, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { resolveMobileAppearance } from "../lib/appearance";
import type { CreateAction } from "../lib/create-chooser";
import { createMenuActions, isCreateAction } from "../lib/create-chooser";
import { useMobileTokens, useThemedStyles } from "../lib/native";
import { androidRipple } from "../lib/ripple";
import { GlassSurface } from "./glass-surface";
import { CREATE_MENU_GAP, createHomeStyles } from "./home-styles";
import { NativeSymbol } from "./native-symbol";

/**
 * The inbox's own header where it has no native bar: beside a chat in split view, and before
 * iOS 26. The account on the left, create on the right, each a raised circle.
 */
export function InboxHeader({
  initials,
  runCreateAction,
  columnInsets,
  title,
  embedded = false,
}: {
  initials: string;
  runCreateAction: (action: CreateAction) => void;
  columnInsets: { left: number; right: number };
  title?: ReactNode;
  embedded?: boolean;
}) {
  const tokens = useMobileTokens();
  const appearance = resolveMobileAppearance();
  const styles = useThemedStyles(createHomeStyles);
  const { t } = useLingui();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  return (
    <View
      style={[
        styles.header,
        {
          // The split inbox shares the native toolbar row. The window's expanded status
          // area can extend over the chat without occupying the sidebar's controls.
          paddingTop:
            embedded && Platform.OS === "ios"
              ? Math.min(insets.top, 20) + 4
              : Math.max(insets.top, 20) + 12,
          paddingLeft: 16 + columnInsets.left,
          paddingRight: 16 + columnInsets.right,
        },
      ]}
    >
      <GlassSurface shape="circle" tint={tokens.secondary} style={styles.headerCircle}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t`Account`}
          onPress={() => router.push("/account")}
          android_ripple={androidRipple()}
          style={({ pressed }) => [
            styles.circleButton,
            pressed && Platform.OS !== "android" && styles.rowPressed,
          ]}
        >
          <Text style={styles.profileInitials}>{initials}</Text>
        </Pressable>
      </GlassSurface>
      {title}
      <MenuView
        actions={createMenuActions(Platform.OS)}
        {...(Platform.OS === "android" ? { style: { marginBottom: -CREATE_MENU_GAP } } : {})}
        colorScheme={appearance}
        onPressAction={({ nativeEvent }) => {
          if (isCreateAction(nativeEvent.event)) runCreateAction(nativeEvent.event);
        }}
      >
        <View
          accessibilityLabel={t`Create`}
          accessibilityRole="button"
          style={Platform.OS === "android" && styles.createMenuAnchor}
        >
          <GlassSurface shape="circle" style={styles.headerCircle}>
            <NativeSymbol ios="plus" android="add" size={24} />
          </GlassSurface>
        </View>
      </MenuView>
    </View>
  );
}
