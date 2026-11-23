import { MenuView } from "@expo/ui/community/menu";
import { useLingui } from "@lingui/react/macro";
import { useRouter } from "expo-router";
import type { ReactNode } from "react";
import { Platform, Pressable, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { mobileTokens, resolveMobileAppearance } from "../../lib/appearance/appearance";
import type { CreateAction } from "../../lib/inbox/create-chooser";
import { createMenuActions, isCreateAction } from "../../lib/inbox/create-chooser";
import { setInboxHidden, useSplitView } from "../../lib/layout/split-view";
import { useThemedStyles } from "../../lib/native/native";
import { GlassSurface } from "../native/glass-surface";
import { NativeSymbol } from "../native/native-symbol";
import { CREATE_MENU_GAP, createInboxStyles } from "./inbox-styles";

const STATUS_BAR_HEIGHT = 24;

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
  const styles = useThemedStyles(createInboxStyles);
  const { t } = useLingui();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { foldActive } = useSplitView();
  return (
    <View
      style={[
        styles.header,
        {
          // The window's expanded status area can extend over the chat without occupying the
          // sidebar, so beside a chat the inset counts no more than the status bar's height.
          paddingTop:
            embedded && Platform.OS === "ios"
              ? Math.min(insets.top, STATUS_BAR_HEIGHT) + 8
              : Math.max(insets.top, 20) + 8,
          paddingLeft: 16 + columnInsets.left,
          paddingRight: 16 + columnInsets.right,
        },
      ]}
    >
      {/* Beside a chat the account sits at the foot of the list, and this corner hides the list
          unless a fold keeps it in place. */}
      {embedded ? (
        foldActive ? null : (
          <GlassSurface
            shape="circle"
            style={styles.headerCircle}
            fallbackStyle={styles.headerFill}
          >
            <HeaderButton accessibilityLabel={t`Hide chats`} onPress={() => setInboxHidden(true)}>
              <NativeSymbol ios="sidebar.left" android="expand-outline" size={19} />
            </HeaderButton>
          </GlassSurface>
        )
      ) : (
        <GlassSurface shape="circle" style={styles.headerCircle} fallbackStyle={styles.headerFill}>
          <HeaderButton accessibilityLabel={t`Account`} onPress={() => router.push("/account")}>
            <Text style={styles.profileInitials}>{initials}</Text>
          </HeaderButton>
        </GlassSurface>
      )}
      {/* The title gives way to the buttons when the column is narrow. */}
      {title ? <View style={styles.headerTitle}>{title}</View> : null}
      <View style={styles.headerActions}>
        <GlassSurface style={styles.headerGroup} fallbackStyle={styles.headerFill}>
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
        </GlassSurface>
        {/* Creating is a different kind of action from the ways of looking at chats beside it. */}
        <GlassSurface shape="circle" style={styles.headerCircle} fallbackStyle={styles.headerFill}>
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
  const styles = useThemedStyles(createInboxStyles);
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
