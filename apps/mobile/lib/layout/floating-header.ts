import { HeaderHeightContext } from "expo-router/react-navigation";
import { useContext } from "react";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { iosAtLeast } from "../native/native-controls";

/** Fixed content has no scroll view to apply the native navigation inset. 0 outside a stack. */
export function useFloatingHeaderInset() {
  const height = useHeaderHeightIfAny();
  return iosAtLeast(26) ? height : 0;
}

/**
 * The floating header's inset over the top of the content. Where the status bar runs down one
 * side (the iPhone Duo's outer display), iOS stacks the bar's items in that column and leaves the
 * top empty, so content starts at the top instead of below an empty bar.
 */
export function useTopBarInset() {
  const height = useFloatingHeaderInset();
  const { top, left, right } = useSafeAreaInsets();
  return height > 0 && sideStatusColumn({ top, left, right }) ? 0 : height;
}

/** No top inset and an inset on one side only: a landscape phone has both, a tablet a top one. */
export function sideStatusColumn(insets: { top: number; left: number; right: number }) {
  return insets.top === 0 && insets.left > 0 !== insets.right > 0;
}

/**
 * The native header's height when there is one, and 0 elsewhere: the inbox beside a chat in
 * split view sits outside any stack screen, where `useHeaderHeight` throws.
 */
export function useHeaderHeightIfAny(): number {
  return useContext(HeaderHeightContext) ?? 0;
}
