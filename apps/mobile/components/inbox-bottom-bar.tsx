import { useLingui } from "@lingui/react/macro";
import { useRouter } from "expo-router";
import { Platform, Pressable, Text, View } from "react-native";
import { translucentColor } from "../lib/color";
import { useMobileTokens, useThemedStyles } from "../lib/native";
import { androidRipple } from "../lib/ripple";
import { GlassIconButton } from "./glass-icon-button";
import { GlassSurface } from "./glass-surface";
import { BOTTOM_BAR, createHomeStyles } from "./home-styles";
import { NativeSymbol } from "./native-symbol";

/** The bar's height above the screen's bottom edge, for the list and pills it floats over. */
export function inboxBottomBarHeight(bottomInset: number) {
  return BOTTOM_BAR.top + BOTTOM_BAR.control + Math.max(bottomInset, BOTTOM_BAR.minBottom);
}

/**
 * Floats over the end of the inbox: the activity view's toggle and the way into search, which
 * opens the search sheet with its own field.
 */
export function InboxBottomBar({
  activityMode,
  toggleActivityMode,
  bottomInset,
  columnInsets,
}: {
  activityMode: boolean;
  toggleActivityMode: () => void;
  bottomInset: number;
  columnInsets: { left: number; right: number };
}) {
  const tokens = useMobileTokens();
  const styles = useThemedStyles(createHomeStyles);
  const { t } = useLingui();
  const router = useRouter();
  return (
    <View
      pointerEvents="box-none"
      style={[
        styles.bottomBar,
        {
          paddingBottom: Math.max(bottomInset, BOTTOM_BAR.minBottom),
          paddingLeft: 16 + columnInsets.left,
          paddingRight: 16 + columnInsets.right,
          // Rows scrolling under the bar fade into the page.
          experimental_backgroundImage: `linear-gradient(${translucentColor(tokens.background, 0)}, ${tokens.background} 30%)`,
        },
      ]}
    >
      <GlassIconButton
        accessibilityLabel={t`Activity`}
        ios={activityMode ? "bell.fill" : "bell"}
        android={activityMode ? "notifications" : "notifications-outline"}
        size={BOTTOM_BAR.control}
        selected={activityMode}
        onPress={toggleActivityMode}
      />
      <GlassSurface style={styles.searchField}>
        <Pressable
          testID="home-search-button"
          accessibilityRole="button"
          accessibilityLabel={t`Search`}
          onPress={() => router.push("/search")}
          android_ripple={androidRipple()}
          style={({ pressed }) => [
            styles.searchPressable,
            pressed && Platform.OS !== "android" && styles.rowPressed,
          ]}
        >
          <NativeSymbol
            ios="magnifyingglass"
            android="search"
            size={24}
            color={tokens.mutedForeground}
          />
          <Text style={styles.searchPlaceholder} numberOfLines={1}>
            {t`Search`}
          </Text>
        </Pressable>
      </GlassSurface>
    </View>
  );
}
