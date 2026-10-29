import { HeaderHeightContext, useHeaderHeight } from "expo-router/react-navigation";
import { useContext } from "react";
import { iosAtLeast } from "./native-controls";

/** Fixed content has no scroll view to apply the native navigation inset. */
export function useFloatingHeaderInset() {
  const height = useHeaderHeight();
  return iosAtLeast(26) ? height : 0;
}

/**
 * The native header's height when there is one, and 0 elsewhere: the inbox beside a chat in
 * split view sits outside any stack screen, where `useHeaderHeight` throws.
 */
export function useHeaderHeightIfAny(): number {
  return useContext(HeaderHeightContext) ?? 0;
}
