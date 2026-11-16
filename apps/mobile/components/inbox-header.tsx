import { MenuView } from "@expo/ui/community/menu";
import { useLingui } from "@lingui/react/macro";
import { useRouter } from "expo-router";
import type { ReactNode } from "react";
import { Platform, Pressable, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { mobileTokens, resolveMobileAppearance } from "../lib/appearance";
import type { CreateAction } from "../lib/create-chooser";
import { createMenuActions, isCreateAction } from "../lib/create-chooser";
import { useThemedStyles } from "../lib/native";
import { GlassSurface } from "./glass-surface";
import { CREATE_MENU_GAP, createHomeStyles } from "./home-styles";
import { NativeSymbol } from "./native-symbol";

/**
 * The inbox's own header where it has no native bar: beside a chat in split view, and before
 * iOS 26. Its controls sit on Liquid Glass wherever that exists.
 */
export function InboxHeader({
  initials,
  activityMode,
  toggleActivityMode,
  runCreateAction,
  columnInsets,
  title,
  embedded = false,
}: {
  initials: string;
  activityMode: boolean;
  toggleActivityMode: () => void;
  runCreateAction: (action: CreateAction) => void;
  columnInsets: { left: number; right: number };
  title?: ReactNode;
  embedded?: boolean;
}) {
  const tokens = mobileTokens();
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
              : Math.max(insets.top, 20) + 8,
          paddingLeft: 16 + columnInsets.left,
          paddingRight: 16 + columnInsets.right,
        },
      ]}
    >
      <GlassSurface shape="circle" style={styles.headerCircle} fallbackStyle={styles.headerFill}>
        <HeaderButton accessibilityLabel={t`Account`} onPress={() => router.push("/account")}>
          <Text style={styles.profileInitials}>{initials}</Text>
        </HeaderButton>
      </GlassSurface>
      {title}
      <GlassSurface style={styles.headerActions} fallbackStyle={styles.headerFill}>
        <HeaderButton
          accessibilityLabel={t`Activity`}
          active={activityMode}
          accent
          onPress={toggleActivityMode}
        >
          <NativeSymbol
            ios={activityMode ? "bell.fill" : "bell"}
            android={activityMode ? "notifications" : "notifications-outline"}
            size={17}
            color={activityMode ? tokens.primaryForeground : tokens.foreground}
          />
        </HeaderButton>
        <HeaderButton
          testID="home-search-button"
          accessibilityLabel={t`Search`}
          onPress={() => router.push("/search")}
        >
          <NativeSymbol ios="magnifyingglass" android="search" size={17} />
        </HeaderButton>
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
            style={[styles.headerButton, Platform.OS === "android" && styles.createMenuAnchor]}
          >
            <NativeSymbol ios="plus" android="add" size={18} />
          </View>
        </MenuView>
      </GlassSurface>
    </View>
  );
}

function HeaderButton({
  testID,
  children,
  onPress,
  accessibilityLabel,
  active = false,
  accent = false,
}: {
  children: ReactNode;
  onPress: () => void;
  accessibilityLabel: string;
  testID?: string;
  active?: boolean;
  accent?: boolean;
}) {
  const styles = useThemedStyles(createHomeStyles);
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ selected: active }}
      onPress={onPress}
      hitSlop={4}
      style={({ pressed }) => [
        styles.headerButton,
        accent && active
          ? styles.headerButtonAccent
          : (active || pressed) && styles.headerButtonActive,
      ]}
    >
      {children}
    </Pressable>
  );
}
